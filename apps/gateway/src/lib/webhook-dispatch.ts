/**
 * Webhook dispatch, turn a `WebhookEvent` into one or more queued
 * `WebhookDeliveryDoc` rows.
 *
 * Signing happens at delivery time (in the cron route), not here, so each
 * retry picks up a fresh `t=<unix>` and the replay window stays short.
 *
 * Callers are typically fire-and-forget (e.g. message routes after a
 * successful enqueue). Failures must be logged but never propagated, a
 * webhook configuration issue must not break the underlying API call.
 */
import 'server-only';
import { canonicalJson, type WebhookEvent } from '@hmddevs/protocol';
import { enqueueDelivery, type WebhookDeliveryDoc } from './repositories/webhook-deliveries';
import { findMatchingRoutes } from './repositories/webhook-routes';
import { logger } from './logger';

export interface DispatchScope {
  /** Routes scoped to any of these API keys will receive the event. */
  apiKeyIds?: string[];
  /** Routes scoped to any of these sessions will receive the event. */
  sessionIds?: string[];
  /** Convenience, single API key. */
  apiKeyId?: string;
  /** Convenience, single session. */
  sessionId?: string;
}

export interface DispatchResult {
  deliveriesQueued: number;
  routesMatched: number;
}

function normaliseScope(scope: DispatchScope): {
  apiKeyIds: string[];
  sessionIds: string[];
} {
  const apiKeyIds = [...(scope.apiKeyIds ?? []), ...(scope.apiKeyId ? [scope.apiKeyId] : [])];
  const sessionIds = [...(scope.sessionIds ?? []), ...(scope.sessionId ? [scope.sessionId] : [])];
  return { apiKeyIds, sessionIds };
}

/**
 * Resolve all matching routes for `(eventType, scope)` and enqueue one
 * delivery per route. Errors during enqueue for one route do not block
 * the others.
 */
export async function dispatchEvent(
  event: WebhookEvent,
  scope: DispatchScope,
): Promise<DispatchResult> {
  // why: chat_event* (live device-side outbound, group capture, history sync)
  // and contact_batch must NEVER fan out to webhook subscribers, they're
  // either our own outbound or historical replays. Per-branch `// why:` notes
  // in the callback routes already enforce this; this guard is defence-in-depth
  // so a future caller that forgets the per-branch rule fails closed instead of
  // silently spamming subscribers with years-old messages.
  // why: today's `WebhookEvent.type` is a closed union that doesn't include
  // these literals, so the comparison below cannot match in practice, the
  // value is intentional dead-on-arrival. It exists to catch a future
  // widening of `WebhookEvent.type` that forgets this invariant: the runtime
  // guard trips before any delivery is queued.
  const eventType = event.type as string;
  if (eventType.startsWith('chat_event') || eventType === 'contact_batch') {
    logger.warn(
      { eventType, eventId: event.eventId },
      'webhook dispatch blocked for non-fanout event type',
    );
    return { deliveriesQueued: 0, routesMatched: 0 };
  }

  const { apiKeyIds, sessionIds } = normaliseScope(scope);
  if (apiKeyIds.length === 0 && sessionIds.length === 0) {
    logger.warn({ eventType: event.type }, 'webhook dispatch with empty scope; skipping');
    return { deliveriesQueued: 0, routesMatched: 0 };
  }

  const routes = await findMatchingRoutes({
    eventType: event.type,
    apiKeyIds,
    sessionIds,
  });
  if (routes.length === 0) {
    return { deliveriesQueued: 0, routesMatched: 0 };
  }

  // Canonical JSON of the event, these are the exact bytes that get signed
  // and POSTed. Storing them now means retries reproduce them byte-for-byte.
  const payload = canonicalJson(event);

  const queued: WebhookDeliveryDoc[] = [];
  for (const route of routes) {
    try {
      const doc = await enqueueDelivery({
        routeId: route.routeId,
        eventId: event.eventId,
        eventType: event.type,
        payload,
        url: route.url,
      });
      queued.push(doc);
    } catch (err: unknown) {
      logger.error(
        {
          err: (err as Error).message,
          routeId: route.routeId,
          eventId: event.eventId,
          eventType: event.type,
        },
        'webhook enqueueDelivery failed',
      );
    }
  }

  return { deliveriesQueued: queued.length, routesMatched: routes.length };
}

/**
 * Fire-and-forget wrapper. Logs failures but never throws. Use this in
 * request paths where webhook delivery is incidental (e.g. POST /v1/messages).
 */
export function dispatchEventBackground(event: WebhookEvent, scope: DispatchScope): void {
  dispatchEvent(event, scope).catch((err: unknown) => {
    logger.warn(
      {
        err: (err as Error).message,
        eventType: event.type,
        eventId: event.eventId,
      },
      'webhook dispatch background failed',
    );
  });
}

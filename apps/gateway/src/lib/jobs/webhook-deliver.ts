/**
 * Job: webhook delivery sweep.
 *
 * Extracted from `app/api/cron/webhook-deliver/route.ts` with behaviour
 * unchanged. Pulls a batch of due (`status=pending` AND `nextAttemptAt<=now`)
 * deliveries, POSTs each in parallel, and persists the outcome. Retries follow
 * the `WEBHOOK_DELIVERY_RETRY_DELAYS_SEC` schedule from the protocol package;
 * after `WEBHOOK_MAX_ATTEMPTS` failed attempts, the delivery is `abandoned`.
 *
 * Shared by the HTTP cron route and the in-process scheduler.
 */
import 'server-only';
import { logger } from '@/lib/logger';
import {
  claimDueDeliveries,
  markAbandoned,
  markFailed,
  markSent,
  type WebhookDeliveryDoc,
} from '@/lib/repositories/webhook-deliveries';
import { getRoute, recordDeliveryOutcome } from '@/lib/repositories/webhook-routes';
import { openSecret } from '@/lib/webhook-secret-crypto';
import { attemptDelivery } from '@/lib/webhook-delivery';

const BATCH_SIZE = 25;

export interface WebhookDeliverResult {
  ok: true;
  scanned: number;
  sent: number;
  failed: number; // failed-and-rescheduled
  abandoned: number;
  skipped: number; // route gone / decrypt failed
}

export async function runWebhookDeliver(): Promise<WebhookDeliverResult> {
  const now = new Date();
  const due = await claimDueDeliveries(now, BATCH_SIZE);
  const summary: WebhookDeliverResult = {
    ok: true,
    scanned: due.length,
    sent: 0,
    failed: 0,
    abandoned: 0,
    skipped: 0,
  };

  if (due.length === 0) {
    return summary;
  }

  const results = await Promise.allSettled(
    due.map((d) =>
      deliverOne(d).catch((err: unknown) => {
        logger.error(
          { err: (err as Error).message, deliveryId: d.deliveryId, routeId: d.routeId },
          'webhook delivery handler crashed',
        );
        return { kind: 'skipped' as const };
      }),
    ),
  );

  for (const r of results) {
    if (r.status !== 'fulfilled') {
      summary.skipped += 1;
      continue;
    }
    switch (r.value.kind) {
      case 'sent':
        summary.sent += 1;
        break;
      case 'failed':
        summary.failed += 1;
        break;
      case 'abandoned':
        summary.abandoned += 1;
        break;
      case 'skipped':
        summary.skipped += 1;
        break;
    }
  }

  logger.info(summary, 'webhook delivery sweep complete');
  return summary;
}

type DeliveryResultKind = 'sent' | 'failed' | 'abandoned' | 'skipped';

async function deliverOne(delivery: WebhookDeliveryDoc): Promise<{ kind: DeliveryResultKind }> {
  const route = await getRoute(delivery.routeId);
  if (!route || route.revokedAt || !route.active) {
    // Route gone or disabled, terminate the delivery immediately rather
    // than burning retry slots over the next ~30 hours.
    await markAbandoned(delivery.deliveryId, 'route inactive or revoked');
    return { kind: 'abandoned' };
  }

  let secret: string;
  try {
    secret = openSecret({
      ciphertext: route.secretCiphertext,
      iv: route.secretIv,
      authTag: route.secretAuthTag,
    });
  } catch (err: unknown) {
    // why: a decrypt failure means the at-rest secret blob is corrupt or the
    // WEBHOOK_DELIVERY_KEY has been rotated without re-sealing. Neither
    // resolves itself; retrying 6 more times over the next 30 hours would
    // just delay diagnosis. Abandon immediately and surface in logs.
    logger.error(
      { err: (err as Error).message, routeId: route.routeId, deliveryId: delivery.deliveryId },
      'webhook secret decrypt failed; abandoning delivery',
    );
    await markAbandoned(delivery.deliveryId, 'secret_decrypt_failed');
    return { kind: 'abandoned' };
  }

  const result = await attemptDelivery({
    url: delivery.url,
    payload: delivery.payload,
    secret,
    eventType: delivery.eventType,
    deliveryId: delivery.deliveryId,
  });

  if (result.ok) {
    await markSent(delivery.deliveryId, result.httpStatus ?? 0);
    await recordDeliveryOutcome(route.routeId, {
      status: 'sent',
      httpStatus: result.httpStatus,
      at: new Date(),
    });
    return { kind: 'sent' };
  }

  const outcome = await markFailed(delivery.deliveryId, {
    httpStatus: result.httpStatus,
    error: result.error ?? 'unknown',
  });
  await recordDeliveryOutcome(route.routeId, {
    status: 'failed',
    httpStatus: result.httpStatus,
    at: new Date(),
  });
  return { kind: outcome.status === 'abandoned' ? 'abandoned' : 'failed' };
}

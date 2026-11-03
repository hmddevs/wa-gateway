/**
 * Admin Conversations live-stream pub/sub.
 *
 * The admin SSE route at `/api/admin/sessions/:id/stream` subscribes to
 * `admin:stream:<sessionId>` for real-time updates. The worker callback
 * publishes onto the same channel after persisting an inbound, a live
 * `chat_event`, or a message status change.
 *
 * Channel naming is deliberately distinct from the worker-internal
 * `wa:inbound:<workerId>` channels, those are queue plumbing; this one is
 * admin fan-out. Reusing the worker channel would couple two unrelated
 * lifecycles and risk leaking worker queue payloads into the admin UI.
 *
 * Publish failures are caught and logged; we never let a Redis hiccup
 * propagate into the worker callback ack path. Persistence has already
 * succeeded by the time we publish, so a dropped frame is recoverable on
 * the next admin reconnect (which refetches via the existing GET threads
 * endpoint).
 */
import 'server-only';
import type { AdminStreamEvent, AdminStreamEnvelope } from '@hmddevs/protocol';
import { getRedis } from './redis';
import { logger } from './logger';

export function adminStreamChannel(sessionId: string): string {
  return `admin:stream:${sessionId}`;
}

/** Fire-and-forget publish to the admin SSE channel for one session. */
export async function publishAdminStream(event: AdminStreamEvent): Promise<void> {
  const envelope: AdminStreamEnvelope = {
    at: new Date().toISOString(),
    event,
  };
  try {
    await getRedis().publish(adminStreamChannel(event.sessionId), JSON.stringify(envelope));
  } catch (err: unknown) {
    logger.warn(
      {
        err: (err as Error).message,
        sessionId: event.sessionId,
        kind: event.kind,
      },
      'admin-stream publish failed',
    );
  }
}

/**
 * Job: scheduled-message dispatch.
 *
 * Extracted from `app/api/cron/scheduled-dispatch/route.ts` with behaviour
 * unchanged. Sweeps `messages` for `status='scheduled' AND scheduledFor<=now`,
 * signs a `send` envelope per message and publishes it to the worker exactly as
 * the synchronous send route would. On success the message flips to `queued`
 * with `dispatchedAt` set; the worker's `send_ack` then drives the rest of the
 * status machine. Sessions that are gone or stopped fail-out the message.
 *
 * Shared by the HTTP cron route and the in-process scheduler.
 */
import 'server-only';
import { logger } from '@/lib/logger';
import {
  claimOneDueScheduled,
  markFailedFromSchedule,
  restampRouting,
  type MessageDoc,
} from '@/lib/repositories/messages';
import { getSession, type SessionDoc } from '@/lib/repositories/sessions';
import { routeSend } from '@/lib/org-router';
import { getRedis } from '@/lib/redis';
import { channels, sign, newNonce, nowIso, lpushPending } from '@/lib/wire';
import { resolveSafeHost } from '@/lib/safe-fetch';

const BATCH_SIZE = 50;

export interface ScheduledDispatchResult {
  ok: true;
  dispatched: number;
  failed: number;
  scanned: number;
}

export async function runScheduledDispatch(): Promise<ScheduledDispatchResult> {
  // Drain loop: atomically claim one message at a time. Two concurrent
  // invocations will never claim the same message because claimOneDueScheduled
  // uses findOneAndUpdate (scheduled → queued) as an atomic fence.
  const redis = getRedis();
  let dispatched = 0;
  let failed = 0;
  let scanned = 0;

  while (scanned < BATCH_SIZE) {
    const msg = await claimOneDueScheduled();
    if (!msg) break; // queue empty
    scanned += 1;

    try {
      // An organization message is routed HERE, not when it was enqueued. The
      // number that looked best an hour ago may since have dropped, been
      // paused, or burned through its budget, routing at fire time is the
      // whole reason `orgId` is carried on the message.
      let session: SessionDoc | null;
      if (msg.orgId) {
        const routed = await routeSend(msg.orgId, msg.to);
        if (!routed.ok) {
          await markFailedFromSchedule(
            msg.messageId,
            `organization ${msg.orgId} has no available number (${routed.reason})`,
          );
          failed += 1;
          continue;
        }
        session = routed.session;
        // The ack path, viewer and pending list all key off `sessionId`, so
        // persist the routed number before publishing on its channel.
        msg.sessionId = session.sessionId;
        msg.workerId = session.workerId;
        await restampRouting(msg.messageId, session.sessionId, session.workerId);
      } else {
        session = await getSession(msg.sessionId);
        if (!session || session.status === 'stopped') {
          await markFailedFromSchedule(
            msg.messageId,
            session ? `session ${msg.sessionId} stopped` : `session ${msg.sessionId} missing`,
          );
          failed += 1;
          continue;
        }
      }

      await publishSend(redis, msg, session.workerId);
      dispatched += 1;
    } catch (err: unknown) {
      logger.error(
        { err: (err as Error).message, messageId: msg.messageId },
        'scheduled dispatch failed',
      );
      await markFailedFromSchedule(msg.messageId, (err as Error).message).catch(() => {});
      failed += 1;
    }
  }

  logger.info({ scanned, dispatched, failed }, 'scheduled-dispatch sweep complete');
  return { ok: true, dispatched, failed, scanned };
}

async function publishSend(
  redis: ReturnType<typeof getRedis>,
  msg: MessageDoc,
  workerId: string,
): Promise<void> {
  // Re-validate media URLs at dispatch time: the enqueue-time SSRF guard
  // (resolveSafeHost in /v1/messages, test-send, admin send) can be up to 30
  // days stale by the time a scheduled message actually fires, and a DNS
  // rebind in that window would defeat it. Resolve-only; throwing here is
  // caught by runScheduledDispatch's loop, which marks the message failed via
  // markFailedFromSchedule and never calls publishSend again for it. The
  // internal failure reason is safe to log/store (it never contains the
  // caller's URL, resolveSafeHost's errors are fixed reason codes).
  if (msg.body.kind === 'image' || msg.body.kind === 'document') {
    await resolveSafeHost(msg.body.url);
  }

  const envelope = await sign({
    v: 1,
    kind: 'send' as const,
    messageId: msg.messageId,
    to: msg.to,
    body: msg.body,
    channel: msg.channel,
    apiKeyId: msg.apiKeyId,
    requestId: msg.requestId,
    nonce: newNonce(),
    at: nowIso(),
    sig: '',
  });
  const wire = JSON.stringify(envelope);
  // Match the exact Redis pattern used by the synchronous send route:
  // push to the pending list AND publish on the outbound channel. Use the
  // session id as the channel key (the send route uses `apiKey.sessionId`,
  // which equals `msg.sessionId` here, keep parity with that convention).
  void workerId;
  await Promise.all([
    lpushPending(msg.sessionId, wire),
    redis.publish(channels.outbound(msg.sessionId), wire),
  ]);
}

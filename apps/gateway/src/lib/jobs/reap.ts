/**
 * Job: expire messages whose TTL has elapsed and re-publish any messages still
 * in `queued` for more than 30 seconds (worker likely restarted).
 *
 * Extracted from `app/api/cron/reap/route.ts` so the same logic can be driven
 * by both the HTTP cron route and the in-process scheduler. Behaviour is
 * unchanged from the route: it also raises a stalled-queue alarm (if messages
 * have been sitting in `queued` for over 5 minutes the worker is publishing-
 * but-deaf or down) via a single rate-limited alert email.
 *
 * The route-only `?selftest=1` alert-pipeline check stays in the route; it is
 * HTTP-shaped (reads a query param) and not part of the scheduled run.
 */
import 'server-only';
import { reapExpired, countStalledQueued } from '@/lib/repositories/messages';
import { mintRequestId } from '@/lib/request-id';
import { getRedis } from '@/lib/redis';
import { sendAlertEmail } from '@/lib/email';
import { logger } from '@/lib/logger';

/** A message queued longer than this is considered stalled. */
const STALL_THRESHOLD_MS = 5 * 60_000;
/** Suppress repeat alerts for this long after one fires. */
const ALERT_COOLDOWN_S = 15 * 60;
const ALERT_LOCK_KEY = 'wa:alarm:stalled-queue';

export interface ReapResult {
  ok: true;
  expired: number;
  stalled: number;
  alerted: boolean;
}

/**
 * Run one reap sweep: expire TTL-elapsed messages, then check for a stalled
 * queue and fire one rate-limited alert if found.
 *
 * @param requestId Optional correlation id; minted if absent so log lines and
 *   the alert email carry a stable handle whether driven by cron or scheduler.
 */
export async function runReap(requestId: string = mintRequestId(null)): Promise<ReapResult> {
  const expired = await reapExpired();

  let stalled = 0;
  let alerted = false;
  try {
    stalled = await countStalledQueued(new Date(Date.now() - STALL_THRESHOLD_MS));
    if (stalled > 0) {
      // SET NX EX, only the first caller within the cooldown wins the lock and
      // sends; subsequent ticks see the key and skip. Idempotent rate-limit.
      const lock = await getRedis().set(ALERT_LOCK_KEY, '1', 'EX', ALERT_COOLDOWN_S, 'NX');
      if (lock === 'OK') {
        await sendAlertEmail({
          subject: `wa-gateway: ${stalled} messages stalled in queue`,
          text:
            `${stalled} message(s) have been stuck in 'queued' for over 5 minutes.\n\n` +
            `Likely cause: the worker is connected over its HTTP heartbeat but its ` +
            `Redis outbound subscription is down (half-open), or the worker is offline. ` +
            `Check the session's 'subscribed' health and the worker process.\n\n` +
            `requestId: ${requestId}`,
        });
        alerted = true;
        logger.warn({ stalled, requestId }, 'stalled-queue alarm fired');
      }
    }
  } catch (err) {
    // Alarm path is best-effort: never let it fail the reap response. Log loud.
    logger.error({ err: (err as Error).message, stalled, requestId }, 'stalled-queue alarm failed');
  }

  return { ok: true, expired, stalled, alerted };
}

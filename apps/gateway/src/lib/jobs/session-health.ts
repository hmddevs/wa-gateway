/**
 * Job: session-disconnect alarm.
 *
 * When the worker's WhatsApp session drops (process death, or the session
 * getting invalidated so it sits at a `pairing` QR screen), outbound WhatsApp
 * silently stops. The stalled-queue alarm (see `@/lib/jobs/reap`) only fires
 * once messages have piled up, which lags the real outage. This job watches
 * session health directly and emails the operator the moment a session goes
 * down, then again when it recovers.
 *
 * Detection rule, a session is DOWN when EITHER:
 *   1. its stored `status` is not `connected` (i.e. pairing / degraded /
 *      offline / initialising), OR
 *   2. its heartbeat is stale: `deriveLiveness(lastHeartbeatAt)` is `offline`
 *      (>5min). This catches worker process death where the last-stored status
 *      is a stale "connected".
 *
 * Scope, sessions that are NOT stopped (`stoppedAt == null`) AND are assigned
 * to a worker (`workerId != null`), i.e. expected to be carrying traffic. We
 * deliberately do NOT gate on `connectedAt`: a session that was invalidated and
 * reset can have `connectedAt` cleared while sitting at the pairing screen, and
 * that is precisely the outage this alarm must catch. A genuinely brand-new
 * session being paired for the first time may alert after >5min unpaired, which
 * is acceptable noise (the recovery email confirms when it is scanned).
 *
 * Suppression, a per-session Redis marker `wa:alert:session-down:<id>` with a
 * 6h TTL gates repeat alerts (mirrors the `SET NX EX` rate-limit in the reap
 * alarm). One down-alert per outage; the marker is deleted on recovery, which
 * also triggers the recovery email.
 */
import 'server-only';
import { env } from '@/lib/env';
import { listSessions, type SessionDoc } from '@/lib/repositories/sessions';
import { deriveLiveness } from '@/app/admin/_lib/liveness';
import { getRedis } from '@/lib/redis';
import { sendAlertEmail } from '@/lib/email';
import { logger } from '@/lib/logger';

/** Per-session down-marker key prefix. */
const MARKER_PREFIX = 'wa:alert:session-down:';
/** Marker TTL: bounds the marker so a forgotten outage self-clears. */
const MARKER_TTL_S = 6 * 60 * 60;
/** Operator-facing reconnect link. */
const RECONNECT_URL = env.GATEWAY_PUBLIC_URL;

export interface SessionHealthResult {
  ok: true;
  /** Sessions evaluated (in-scope: not stopped, connected at least once). */
  checked: number;
  /** Fresh down-alerts sent this run. */
  alerted: number;
  /** Recovery alerts sent this run. */
  recovered: number;
}

/** A session is healthy iff status is `connected` AND heartbeat is not offline. */
function isDown(s: SessionDoc): boolean {
  if (s.status !== 'connected') return true;
  const hb = s.lastHeartbeatAt ? s.lastHeartbeatAt.toISOString() : null;
  return deriveLiveness(hb) === 'offline';
}

/** Human-readable heartbeat age, or "never" when there has been no heartbeat. */
function heartbeatAge(lastHeartbeatAt: Date | null): string {
  if (!lastHeartbeatAt) return 'never';
  const ms = Date.now() - lastHeartbeatAt.getTime();
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (seconds < 60) return `${seconds}s`;
  if (minutes < 60) return `${minutes}m`;
  return `${hours}h`;
}

/**
 * Run one session-health sweep. For each in-scope session: alert on a fresh
 * disconnect, suppress while a marker is held, and send a recovery email when a
 * previously-down session returns healthy. Email sends are best-effort: a send
 * failure is logged but never thrown out of the job (mirrors the reap alarm).
 */
export async function checkSessionHealth(): Promise<SessionHealthResult> {
  const redis = getRedis();
  const sessions = await listSessions();

  // In scope: not stopped, and assigned to a worker (expected to be carrying
  // traffic). NOT gated on connectedAt, see the file header for why.
  const inScope = sessions.filter((s) => s.stoppedAt == null && s.workerId != null);

  let alerted = 0;
  let recovered = 0;

  for (const s of inScope) {
    const markerKey = `${MARKER_PREFIX}${s.sessionId}`;
    const down = isDown(s);

    try {
      if (down) {
        // SET NX EX, only the first tick within the marker window wins and
        // sends; later ticks see the key and suppress.
        const lock = await redis.set(markerKey, '1', 'EX', MARKER_TTL_S, 'NX');
        if (lock !== 'OK') continue; // already alerted for this outage

        const phone = s.phoneE164 ?? 'unpaired';
        await sendAlertEmail({
          subject: `wa-gateway: WhatsApp session "${s.sessionId}" is DOWN (sending stopped)`,
          text:
            `Session "${s.sessionId}" is down, outbound WhatsApp has stopped.\n\n` +
            `Phone: ${phone}\n` +
            `Status: ${s.status}\n` +
            `Last heartbeat: ${heartbeatAge(s.lastHeartbeatAt)} ago\n\n` +
            `Scan the QR at ${RECONNECT_URL} to reconnect.`,
        });
        alerted += 1;
        logger.warn({ sessionId: s.sessionId, status: s.status }, 'session-down alarm fired');
      } else {
        // Healthy: clear any held marker and, if there was one, report recovery.
        const removed = await redis.del(markerKey);
        if (removed > 0) {
          const phone = s.phoneE164 ?? 'unpaired';
          await sendAlertEmail({
            subject: `wa-gateway: WhatsApp session "${s.sessionId}" reconnected`,
            text:
              `Session "${s.sessionId}" has reconnected.\n\n` +
              `Phone: ${phone}\n\n` +
              `Sending has resumed.`,
          });
          recovered += 1;
          logger.info({ sessionId: s.sessionId }, 'session reconnected; recovery alert sent');
        }
      }
    } catch (err) {
      // Best-effort: a Redis or email failure for one session must not abort the
      // sweep or fail the job. Log loud and move to the next session.
      logger.error(
        { err: (err as Error).message, sessionId: s.sessionId, down },
        'session-health alarm failed for session',
      );
    }
  }

  // Per-sweep visibility (mirrors scheduled-dispatch's "sweep complete"): lets
  // an operator confirm from the logs that the alarm is actually running and
  // what it saw, without waiting for an email.
  logger.info({ checked: inScope.length, alerted, recovered }, 'session-health sweep complete');

  return { ok: true, checked: inScope.length, alerted, recovered };
}

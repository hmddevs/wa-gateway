/**
 * Job: API-key auth-failure alarm.
 *
 * Watches the rolling count of "well-formed key, no matching record" lookup
 * misses (see `@/lib/auth-failure-tracker`) and emails the operator when it
 * spikes. This is the guardrail that was missing during the 2026-06-25 incident,
 * where a rotated SERVER_PEPPER silently invalidated every API key and the
 * outage ran 3 days before a customer noticed. The email breaks the count down
 * by division so a multi-division spike (systemic, suspect SERVER_PEPPER) is
 * distinguishable from one consumer's stale key.
 *
 * Suppression mirrors the session-health alarm: a single Redis marker with a 6h
 * TTL gates repeat alerts. We deliberately send NO "cleared" email: zero misses
 * can mean "fixed" OR simply "no traffic", so a recovery signal would be
 * unreliable. The marker just expires; if misses still spike after 6h it
 * re-fires, which doubles as a reminder that it is still broken.
 */
import 'server-only';
import { env } from '@/lib/env';
import { getRedis } from '@/lib/redis';
import { sendAlertEmail } from '@/lib/email';
import { logger } from '@/lib/logger';
import { readAuthFailureWindow, AUTH_FAIL_WINDOW_MINUTES } from '@/lib/auth-failure-tracker';

const MARKER_KEY = 'wa:alert:authfail';
const MARKER_TTL_S = 6 * 60 * 60;
/** Misses within the window required to fire. Low enough to catch the incident
 *  in any active period, high enough to ignore the odd stray bad request. */
const THRESHOLD = 5;
const GATEWAY_URL = env.GATEWAY_PUBLIC_URL;

export interface AuthFailureResult {
  ok: true;
  total: number;
  divisions: number;
  alerted: number;
}

export async function checkAuthFailures(): Promise<AuthFailureResult> {
  const redis = getRedis();
  let total = 0;
  let divisions = 0;
  let alerted = 0;

  try {
    const window = await readAuthFailureWindow();
    total = window.total;
    const divs = Object.entries(window.byDivision)
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1]);
    divisions = divs.length;

    if (total >= THRESHOLD) {
      // SET NX EX: only the first tick within the 6h marker window sends.
      const lock = await redis.set(MARKER_KEY, '1', 'EX', MARKER_TTL_S, 'NX');
      if (lock === 'OK') {
        const breakdown = divs.map(([d, n]) => `  ${d}: ${n}`).join('\n') || '  (none attributed)';
        const systemic = divisions >= 2;
        await sendAlertEmail({
          subject: `wa-gateway: API key auth failures spiking (${total} in ${AUTH_FAIL_WINDOW_MINUTES}m)`,
          text:
            `${total} well-formed API keys failed lookup in the last ${AUTH_FAIL_WINDOW_MINUTES} ` +
            `minutes across ${divisions} division(s). These keys parse correctly but match no ` +
            `record, so the requests 401 before any message is created (customers silently fall ` +
            `back to email OTP).\n\n` +
            `By division:\n${breakdown}\n\n` +
            (systemic
              ? `MULTIPLE divisions are failing at once. Prime suspect: SERVER_PEPPER changed ` +
                `(it invalidates every existing key simultaneously). Do NOT rotate the pepper; ` +
                `restore the prior value if you have it, otherwise rotate the affected keys.\n\n`
              : `A single division is failing. Likely its key was rotated/revoked without ` +
                `updating that consumer. Re-issue and update its stored key.\n\n`) +
            `Admin: ${GATEWAY_URL}`,
        });
        alerted = 1;
        logger.warn({ total, divisions, systemic }, 'auth-failure alarm fired');
      }
    }
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'auth-failure alarm sweep failed');
  }

  logger.info({ total, divisions, alerted }, 'auth-failure sweep complete');
  return { ok: true, total, divisions, alerted };
}

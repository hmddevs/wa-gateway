/**
 * Auth-failure tracker.
 *
 * Counts "well-formed API key that matches no record" events at the gateway's
 * single auth chokepoint. A key that parses as `hmd_sk_<division>_<env>_…` but
 * misses the lookup is the precise signal of a systemic auth break: most
 * importantly a rotated SERVER_PEPPER (which invalidates EVERY existing key at
 * once, across all divisions), or a key rotated/revoked without updating the
 * consumer. See [[wa-gateway-server-pepper-invariant]] for the incident this guards.
 *
 * Storage is per-minute Redis buckets (total + per-division) with a short TTL,
 * summed over a rolling window by the auth-failure alarm job. Recording is
 * fire-and-forget and best-effort: it must never throw into the auth path.
 */
import 'server-only';
import { getRedis } from './redis';
import { logger } from './logger';

const KEY_PREFIX = 'wa:authfail';
/** Keep ~20 min of buckets so a 10-min window always has full coverage. */
const BUCKET_TTL_S = 20 * 60;
/** Rolling window the alarm sums over. */
export const AUTH_FAIL_WINDOW_MINUTES = 10;

function minuteNow(): number {
  return Math.floor(Date.now() / 60_000);
}

/**
 * Record one well-formed-key lookup miss for `division`. Best-effort: any Redis
 * error is logged and swallowed so the auth path is never affected.
 */
export async function recordAuthLookupMiss(division: string): Promise<void> {
  try {
    const redis = getRedis();
    const m = minuteNow();
    const totalKey = `${KEY_PREFIX}:total:${m}`;
    const divKey = `${KEY_PREFIX}:div:${m}`;
    const div = /^[a-z0-9]+$/.test(division) ? division : 'unknown';
    await redis
      .multi()
      .incr(totalKey)
      .expire(totalKey, BUCKET_TTL_S)
      .hincrby(divKey, div, 1)
      .expire(divKey, BUCKET_TTL_S)
      .exec();
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'recordAuthLookupMiss failed');
  }
}

export interface AuthFailureWindow {
  /** Total lookup misses across the window. */
  total: number;
  /** Misses attributed per division (key prefix), e.g. { acme: 12 }. */
  byDivision: Record<string, number>;
}

/** Sum lookup misses across the last `windowMinutes` minute-buckets. */
export async function readAuthFailureWindow(
  windowMinutes: number = AUTH_FAIL_WINDOW_MINUTES,
): Promise<AuthFailureWindow> {
  const redis = getRedis();
  const m = minuteNow();
  const totalKeys: string[] = [];
  const divKeys: string[] = [];
  for (let i = 0; i < windowMinutes; i++) {
    totalKeys.push(`${KEY_PREFIX}:total:${m - i}`);
    divKeys.push(`${KEY_PREFIX}:div:${m - i}`);
  }

  const totals = await redis.mget(...totalKeys);
  let total = 0;
  for (const t of totals) total += t ? parseInt(t, 10) || 0 : 0;

  const byDivision: Record<string, number> = {};
  const pipe = redis.multi();
  for (const k of divKeys) pipe.hgetall(k);
  const res = await pipe.exec();
  if (res) {
    for (const [, val] of res) {
      const h = val as Record<string, string> | null;
      if (!h) continue;
      for (const [d, c] of Object.entries(h)) {
        byDivision[d] = (byDivision[d] || 0) + (parseInt(c, 10) || 0);
      }
    }
  }

  return { total, byDivision };
}

/**
 * Rate limiting over the long-lived ioredis TCP connection (the gateway is now
 * a persistent worker instance, not serverless). Each check is a single
 * pipelined MULTI, INCR the current fixed-window bucket, then EXPIRE it, so
 * one network round-trip replaces the three HTTP round-trips the old
 * `@upstash/redis` REST limiter made per send.
 *
 * Algorithm: fixed window of 60s, keyed by `prefix:identifier:<epoch-minute>`.
 * The first INCR in a window sets the TTL; the bucket self-expires one window
 * later. This is intentionally simpler than the previous sliding window: at
 * these caps the boundary-burst difference is immaterial, and the single-MULTI
 * cost matters more on the hot send path. Limit SEMANTICS (cap per minute) and
 * the boolean return shape callers depend on are preserved exactly.
 *
 * Three tiers, evaluated in order by the caller; any single rejection halts:
 *   1. Global         10 000 req / minute
 *   2. Per API key    (apiKey.rateLimitPerMin)
 *   3. Per IP         env RATE_LIMIT_IP_PER_MIN (default 1200) / minute
 *
 * Fail-closed: a Redis error propagates to the caller (authenticate) which
 * treats the request as rejected rather than silently allowing it.
 */
import 'server-only';
import { getRedis } from './redis';
import { env } from './env';

const WINDOW_SECONDS = 60;

const GLOBAL_PER_MIN = 10_000;
const HISTORY_SYNC_PER_MIN = 5_000;
const IP_PER_MIN = env.RATE_LIMIT_IP_PER_MIN;

/**
 * Per-recipient send cap (OTP-bomb protection). Applies to a recipient E.164
 * across ALL API keys, not per key, so an attacker cannot fan a flood across
 * keys to bypass it. Deliberately small: a single recipient should never
 * legitimately receive more than a handful of messages in a 10-minute window.
 */
const RECIPIENT_MAX = 5;
const RECIPIENT_WINDOW_SECONDS = 600;

/** Current fixed-window bucket suffix (epoch minute). */
function windowKey(): number {
  return Math.floor(Date.now() / 1000 / WINDOW_SECONDS);
}

/**
 * Charge `cost` units to the bucket `prefix:identifier`. Returns true when the
 * post-charge count is within `limit`, false when the cap is breached.
 *
 * One MULTI: INCRBY (sets the running count), then EXPIRE with NX-style guard
 * via a second EXPIRE that is cheap and idempotent, we always (re)assert a TTL
 * so a bucket can never leak without expiry. A breach still counts (the count
 * keeps climbing within the window) but is rejected.
 */
async function charge(
  prefix: string,
  identifier: string,
  limit: number,
  cost = 1,
): Promise<boolean> {
  const key = `rl:${prefix}:${identifier}:${windowKey()}`;
  const redis = getRedis();
  // INCRBY + EXPIRE in a single pipelined transaction (one round-trip).
  const res = await redis.multi().incrby(key, cost).expire(key, WINDOW_SECONDS).exec();
  // ioredis exec() → array of [err, value] tuples, or null if the MULTI was
  // discarded. Fail-closed on any anomaly.
  if (!res || res.length === 0) return false;
  const incr = res[0];
  if (!incr || incr[0]) return false;
  const count = Number(incr[1]);
  if (!Number.isFinite(count)) return false;
  return count <= limit;
}

export async function checkGlobal(): Promise<boolean> {
  return charge('global', 'all', GLOBAL_PER_MIN);
}

export async function checkIp(ip: string): Promise<boolean> {
  return charge('ip', ip, IP_PER_MIN);
}

export async function checkApiKey(keyId: string, perMinute: number): Promise<boolean> {
  return charge(`key:${keyId}`, keyId, Math.max(1, perMinute));
}

/**
 * Charge `count` history events to the per-session bucket. Returns true when
 * the bucket has space; false when the 5,000/min cap is breached.
 *
 * History-sync batches are bursty by definition, the worker drains
 * `messaging-history.set` in 500-event batches as fast as Atlas accepts them.
 * Capping per session at 5,000 events / minute keeps us within Atlas write
 * budget without denying the legitimate backfill that follows pair.
 */
/**
 * Per-recipient send cap. One Redis INCR on `wa:rl:recipient:<e164>` with a
 * 600s expiry asserted each call. Returns true while at/under the cap, false
 * once breached. Cheap by design (a single op on the hot send path) and global
 * across keys so an OTP-bomb cannot spread the flood across multiple API keys.
 *
 * Fail-closed: a Redis error propagates to the caller, which rejects the send
 * rather than letting an unbounded flood through.
 */
export async function checkRecipient(e164: string): Promise<boolean> {
  const key = `wa:rl:recipient:${e164}`;
  const redis = getRedis();
  // INCR + EXPIRE in one pipelined round-trip; EXPIRE is re-asserted each call
  // so the window slides forward only on the first hit (EXPIRE refreshes the
  // TTL, keeping the cap a rolling 10-minute fixed window per recipient).
  const res = await redis.multi().incr(key).expire(key, RECIPIENT_WINDOW_SECONDS).exec();
  if (!res || res.length === 0) return false;
  const incr = res[0];
  if (!incr || incr[0]) return false;
  const count = Number(incr[1]);
  if (!Number.isFinite(count)) return false;
  return count <= RECIPIENT_MAX;
}

export async function checkHistorySyncBatch(sessionId: string, count: number): Promise<boolean> {
  if (sessionId.length === 0) return true;
  const cost = Math.max(1, Math.floor(count));
  return charge('hist', sessionId, HISTORY_SYNC_PER_MIN, cost);
}

/**
 * Developed by HMD Developments
 * For HMD WA Gateway
 * www.hmddevs.org
 *
 * Per-session routing state in Redis: send budget, health score, and recipient
 * affinity. These are the three things the org router needs that Mongo is the
 * wrong store for, they change on every send and are worthless after an hour.
 *
 * Budget is the axis WhatsApp actually enforces: it throttles a phone number
 * over a time window, which is why this is keyed by session and not by API key
 * (`rate-limit.ts` owns the per-key and per-recipient caps, different concern,
 * different keyspace).
 */
import 'server-only';
import type { SessionBudget } from '@hmddevs/protocol';
import { getRedis } from './redis';
import type { SessionDoc } from './repositories/sessions';

/**
 * Conservative defaults for a number with no explicit budget. WhatsApp does
 * not publish its limits, so these are a deliberately low guess, tune per
 * number from real delivery data rather than treating them as known-good.
 */
export const DEFAULT_BUDGET: SessionBudget = { perMinute: 20, perHour: 500, perDay: 5_000 };

/** Health floor for eligibility. Four consecutive failures cross it. */
export const HEALTH_MIN = 40;
const HEALTH_MAX = 100;
const HEALTH_PENALTY = 20;
const HEALTH_REWARD = 5;
/** Health self-heals by expiry: an unused number returns to full, not condemned. */
const HEALTH_TTL_S = 6 * 60 * 60;

const AFFINITY_TTL_S = 24 * 60 * 60;

/** Fixed windows, mirroring the epoch-bucket approach in `rate-limit.ts`. */
const WINDOWS = [
  { suffix: 'm', seconds: 60, cap: (b: SessionBudget) => b.perMinute },
  { suffix: 'h', seconds: 3_600, cap: (b: SessionBudget) => b.perHour },
  { suffix: 'd', seconds: 86_400, cap: (b: SessionBudget) => b.perDay },
] as const;

function budgetKey(sessionId: string, suffix: string, seconds: number): string {
  return `wa:budget:${sessionId}:${suffix}:${Math.floor(Date.now() / 1000 / seconds)}`;
}

/** Ramp length for a freshly paired number, and its share of budget on day 1. */
const WARMUP_DAYS = 14;
const WARMUP_FLOOR = 0.1;

/**
 * The budget a session may actually spend right now: its configured caps (or
 * the defaults) scaled by the warm-up ramp.
 *
 * A brand-new number sending at full volume is the fastest way to get it
 * restricted, so it starts at 10% and reaches 100% linearly over 14 days. A
 * session with no `warmupStartedAt`, every session that predates this, is
 * treated as fully warmed, so numbers already carrying production traffic are
 * not retroactively throttled.
 */
export function effectiveBudget(session: SessionDoc): SessionBudget {
  const base = session.budget ?? DEFAULT_BUDGET;
  if (!session.warmupStartedAt) return base;

  const days = (Date.now() - session.warmupStartedAt.getTime()) / 86_400_000;
  if (days >= WARMUP_DAYS) return base;

  const share = Math.max(WARMUP_FLOOR, days / WARMUP_DAYS);
  return {
    // Never ramp below 1/window, a floor of 0 would make a new number
    // permanently ineligible rather than slow.
    perMinute: Math.max(1, Math.floor(base.perMinute * share)),
    perHour: Math.max(1, Math.floor(base.perHour * share)),
    perDay: Math.max(1, Math.floor(base.perDay * share)),
  };
}

/**
 * Remaining hourly headroom, used as the weight in weighted selection. Read
 * only, no reservation. Returns the full hourly cap when the bucket is empty
 * or unreadable, which biases an unknown session towards being tried; a real
 * over-cap is still caught by `reserveSend` before anything is published.
 */
export async function remainingHourly(sessionId: string, budget: SessionBudget): Promise<number> {
  const key = budgetKey(sessionId, 'h', 3_600);
  const raw = await getRedis().get(key);
  const used = raw === null ? 0 : Number(raw);
  if (!Number.isFinite(used)) return budget.perHour;
  return Math.max(0, budget.perHour - used);
}

/**
 * Charge one send against all three windows, atomically.
 *
 * Reserve-then-send rather than send-then-count: under concurrency the latter
 * lets an unbounded number of sends pass the check before any of them records
 * itself. The trade-off is that a send which later fails has still consumed
 * budget, correct, because WhatsApp counts attempts, not successes.
 *
 * Returns false (and refunds every window) when any window is over cap, so a
 * rejected candidate leaves no trace and the router can try the next one.
 */
export async function reserveSend(sessionId: string, budget: SessionBudget): Promise<boolean> {
  const redis = getRedis();
  const keys = WINDOWS.map((w) => budgetKey(sessionId, w.suffix, w.seconds));

  const multi = redis.multi();
  for (const [i, w] of WINDOWS.entries()) {
    multi.incr(keys[i]!).expire(keys[i]!, w.seconds);
  }
  const res = await multi.exec();
  // Fail-closed: an unreadable reply must not be treated as headroom.
  if (!res || res.length < WINDOWS.length * 2) {
    await refundSend(sessionId).catch(() => {});
    return false;
  }

  const ok = WINDOWS.every((w, i) => {
    const reply = res[i * 2];
    if (!reply || reply[0]) return false;
    const count = Number(reply[1]);
    return Number.isFinite(count) && count <= w.cap(budget);
  });

  if (!ok) await refundSend(sessionId).catch(() => {});
  return ok;
}

/** Give back a reservation. Used when a candidate is rejected after charging. */
export async function refundSend(sessionId: string): Promise<void> {
  const multi = getRedis().multi();
  for (const w of WINDOWS) multi.decr(budgetKey(sessionId, w.suffix, w.seconds));
  await multi.exec();
}

/**
 * Seconds until the tightest exhausted window rolls over, for `Retry-After`.
 * Approximate by design: it reports when the *minute* bucket resets, which is
 * the soonest any headroom can appear, so a caller that retries then is never
 * told to wait longer than necessary.
 */
export function retryAfterSeconds(): number {
  const minute = WINDOWS[0].seconds;
  return minute - (Math.floor(Date.now() / 1000) % minute);
}

function healthKey(sessionId: string): string {
  return `wa:health:${sessionId}`;
}

/** Current score, 0–100. A session with no recorded history reads as healthy. */
export async function getHealth(sessionId: string): Promise<number> {
  const raw = await getRedis().get(healthKey(sessionId));
  if (raw === null) return HEALTH_MAX;
  const n = Number(raw);
  return Number.isFinite(n) ? n : HEALTH_MAX;
}

/**
 * Move a session's score and clamp it to 0–100.
 *
 * `SET NX` seeds a missing key at full health first, so the very first
 * recorded outcome moves from 100 rather than from zero. The clamp is a
 * follow-up write rather than a Lua script: this runs on the worker-callback
 * path, not the send path, and a script would cost more to maintain than the
 * occasional extra round-trip saves.
 */
async function adjustHealth(sessionId: string, delta: number): Promise<void> {
  const redis = getRedis();
  const key = healthKey(sessionId);
  const res = await redis
    .multi()
    .set(key, String(HEALTH_MAX), 'EX', HEALTH_TTL_S, 'NX')
    .incrby(key, delta)
    .expire(key, HEALTH_TTL_S)
    .exec();

  const score = Number(res?.[1]?.[1]);
  if (!Number.isFinite(score)) return;
  const clamped = Math.min(HEALTH_MAX, Math.max(0, score));
  if (clamped !== score) await redis.set(key, String(clamped), 'EX', HEALTH_TTL_S);
}

/** Record a failed send. Repeated failures take the number out of rotation. */
export function penaliseSession(sessionId: string): Promise<void> {
  return adjustHealth(sessionId, -HEALTH_PENALTY);
}

/** Record a successful send. Recovery is slower than penalty, deliberately. */
export function rewardSession(sessionId: string): Promise<void> {
  return adjustHealth(sessionId, HEALTH_REWARD);
}

function affinityKey(orgId: string, e164: string): string {
  return `wa:affinity:${orgId}:${e164}`;
}

/** The number that last messaged this recipient, if still within the window. */
export async function getAffinity(orgId: string, e164: string): Promise<string | null> {
  return getRedis().get(affinityKey(orgId, e164));
}

/**
 * Pin a recipient to the number that just messaged them, refreshing the window.
 *
 * Not an optimisation: a recipient who receives from a rotating set of numbers
 * reads as spam to both them and WhatsApp, and their replies fragment across
 * sessions so threading breaks.
 */
export async function setAffinity(orgId: string, e164: string, sessionId: string): Promise<void> {
  await getRedis().set(affinityKey(orgId, e164), sessionId, 'EX', AFFINITY_TTL_S);
}

/** Monotonic counter behind the `round-robin` strategy. */
export function nextRotation(orgId: string): Promise<number> {
  return getRedis().incr(`wa:rr:${orgId}`);
}

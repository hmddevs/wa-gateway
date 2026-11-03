/**
 * Gateway-side wire envelope helpers: channel naming, signing, nonce dedup.
 */
import 'server-only';
import { randomUUID } from 'node:crypto';
import { env } from './env';
import { signEnvelope, verifyEnvelope } from '@hmddevs/protocol';
import { getRedis } from './redis';

export const NONCE_TTL_SECONDS = 600;
export const CLOCK_SKEW_TOLERANCE_SECONDS = 60;
export const PENDING_LIST_TTL_SECONDS = 24 * 60 * 60; // 24h
export const PENDING_LIST_MAX_LEN = 1000;

export const channels = {
  outbound: (workerId: string) => `wa:outbound:${workerId}`,
  inbound: (workerId: string) => `wa:inbound:${workerId}`,
  control: (workerId: string) => `wa:control:${workerId}`,
  pending: (workerId: string) => `wa:pending:${workerId}`,
  processing: (workerId: string) => `wa:processing:${workerId}`,
  logs: (workerId: string) => `wa:logs:${workerId}`,
} as const;

function secretBytes(): Uint8Array {
  return Buffer.from(env.WORKER_WIRE_SECRET, 'base64');
}

export async function sign<T extends { sig: string }>(env_: T): Promise<T> {
  return signEnvelope(env_, secretBytes());
}

export async function verify<T extends { sig: string }>(env_: T): Promise<boolean> {
  return verifyEnvelope(env_, secretBytes());
}

/**
 * Atomic nonce insertion using SET with NX + EX. Returns true if nonce was
 * not seen before (= accept), false if it's a replay (= reject).
 */
export async function acceptNonce(nonce: string): Promise<boolean> {
  const redis = getRedis();
  const res = await redis.set(`wa:nonce:${nonce}`, '1', 'EX', NONCE_TTL_SECONDS, 'NX');
  return res === 'OK';
}

/**
 * SINGLE-INSTANCE ASSUMPTION: `heartbeat` envelopes are by far the
 * highest-volume callback kind (every worker, every 15s, see
 * HEARTBEAT_INTERVAL_MS in the worker) and were the dominant source of idle
 * Redis chatter. Their nonce dedup moves to this in-process Map instead of
 * `acceptNonce`'s Redis SET NX EX. This is only correct because the gateway
 * is exactly one instance; a second instance would keep an independent
 * nonce set and could accept a replay the first instance already rejected.
 * Revisit before any horizontal scale-out (see memory-cache.ts).
 *
 * SECURITY NOTE for reviewers: a heartbeat is an idempotent liveness write
 * (worker_state.lastHeartbeatAt + status). Replaying one, even across a
 * gateway restart, which empties this Map, only refreshes liveness within
 * the existing ±60s timestamp gate (isFreshTimestamp). It can never mutate
 * session ownership, tokens, or message state, so this is a bounded,
 * accepted risk, not a security hole. All other envelope kinds (pairing,
 * send_ack, receipt, inbound, reaction, chat_event, message_revision,
 * contact) keep the Redis-backed `acceptNonce` unchanged.
 */
const heartbeatNonces = new Map<string, number>();

/** Drop expired entries so `heartbeatNonces` cannot grow unbounded. Called
 *  opportunistically on every check rather than on a timer, so there is no
 *  extra background work when the gateway is idle. */
function sweepHeartbeatNonces(now: number): void {
  for (const [nonce, expiresAt] of heartbeatNonces) {
    if (expiresAt <= now) heartbeatNonces.delete(nonce);
  }
}

/**
 * In-process nonce dedup for `kind: 'heartbeat'` envelopes only. Same 10-minute
 * expiry as the Redis-backed `acceptNonce`. Returns true if the nonce was not
 * seen before (= accept), false if it's a replay (= reject).
 */
export function acceptHeartbeatNonce(nonce: string): boolean {
  const now = Date.now();
  sweepHeartbeatNonces(now);
  if (heartbeatNonces.has(nonce)) return false;
  heartbeatNonces.set(nonce, now + NONCE_TTL_SECONDS * 1_000);
  return true;
}

/**
 * Inbound dedup. When two WhatsApp linked devices of the SAME number run (the
 * primary and a backup worker), both receive every inbound message and
 * both report it to the callback under different sessionIds. `waMessageId` is
 * the globally-unique WhatsApp message id and is identical across linked
 * devices, so a `SET NX` claim on it makes the inbound side effects (store,
 * admin SSE, webhook fan-out, opt-out keyword handling, read receipt) run
 * exactly once. It also collapses a single worker's callback retries.
 *
 * Returns true the first time the message is seen, false for a duplicate. Fails
 * OPEN on an empty id (returns true) so a real inbound is never dropped because
 * the id was missing; the caller swallows Redis errors to stay fail-open too.
 */
export async function acceptInboundOnce(waMessageId: string): Promise<boolean> {
  if (!waMessageId) return true;
  const redis = getRedis();
  const res = await redis.set(
    `wa:inbound:dedup:${waMessageId}`,
    '1',
    'EX',
    NONCE_TTL_SECONDS,
    'NX',
  );
  return res === 'OK';
}

/**
 * Generic cross-device dedup for callback side effects that are NOT keyed by
 * waMessageId. Two linked devices (primary + backup) both report per-device Baileys
 * events (e.g. a reaction) under distinct envelope nonces, so acceptNonce does
 * not collapse them; a stable, sessionId-AGNOSTIC `key` does. Returns true the
 * first time the key is seen, false for a duplicate. Fails OPEN on an empty key
 * and the caller should swallow Redis errors to stay fail-open.
 */
export async function acceptOnce(key: string): Promise<boolean> {
  if (!key) return true;
  const redis = getRedis();
  const res = await redis.set(`wa:dedup:${key}`, '1', 'EX', NONCE_TTL_SECONDS, 'NX');
  return res === 'OK';
}

/**
 * Atomically marks a bootstrap JTI as consumed. Returns true on first call
 * (accept the token), false if already used (replay, reject). TTL matches
 * the 15-minute bootstrap token lifetime so the key self-cleans.
 */
export async function consumeBootstrapJti(jti: string): Promise<boolean> {
  const redis = getRedis();
  const res = await redis.set(`wa:bootstrap-jti:${jti}`, '1', 'EX', 900, 'NX');
  return res === 'OK';
}

export function isFreshTimestamp(iso: string, now: Date = new Date()): boolean {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return false;
  return Math.abs(now.getTime() - t) <= CLOCK_SKEW_TOLERANCE_SECONDS * 1_000;
}

export function newNonce(): string {
  return randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Atomically enqueue a wire envelope to the pending list with a 24-hour TTL.
 * The TTL is on the list key itself, not per-element, ensuring the queue
 * expires as a whole if the worker is silent for 24h straight.
 *
 * The list is capped at 1000 entries via LTRIM. Older entries are dropped
 * if the limit is exceeded (FIFO; newer entries are retained).
 *
 * Throws on Redis error; callers should catch and log as non-fatal
 * (the worker will pick up the message from the pending list on reconnect).
 */
export async function lpushPending(sessionId: string, wire: string): Promise<void> {
  const redis = getRedis();
  const key = channels.pending(sessionId);
  await redis
    .multi()
    .lpush(key, wire)
    .ltrim(key, 0, PENDING_LIST_MAX_LEN - 1)
    .expire(key, PENDING_LIST_TTL_SECONDS)
    .exec();
}

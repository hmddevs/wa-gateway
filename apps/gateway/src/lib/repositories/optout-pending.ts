/**
 * Pending opt-out confirmation state, ephemeral, self-expiring.
 *
 * The opt-out keyword handshake is two-step: a lone keyword (e.g. "STOP") does
 * NOT suppress the contact immediately. Instead the gateway records a pending
 * request here, prompts the user to confirm, and only a SECOND keyword within
 * the TTL window commits the opt-out. Both steps are real inbound from the
 * customer's WhatsApp number, so the handshake is unfakeable by the sender.
 *
 * State lives in Redis, not Mongo: it is short-lived and must self-expire if
 * the user never confirms.
 */
import 'server-only';
import { getRedis } from '../redis';

/** A pending opt-out request expires 30 minutes after the first keyword. */
export const OPTOUT_CONFIRM_TTL_SECONDS = 30 * 60;

interface PendingOptOut {
  /** The (upper-cased) keyword that triggered the pending request. */
  keyword: string;
  /** ISO timestamp the first keyword was received. */
  at: string;
}

function pendingKey(sessionId: string, e164: string): string {
  return `wa:optout:pending:${sessionId}:${e164}`;
}

/**
 * Atomically open a pending opt-out window, distinguishing the first keyword
 * from the confirmation in a single round-trip.
 *
 * Uses `SET key val NX EX ttl`: the write succeeds ONLY when no window is
 * already open. The boolean return is the whole handshake gate:
 *   - `true`  → this is the FIRST keyword (we created the window). Prompt to confirm.
 *   - `false` → a window is already open, so this is the CONFIRMATION. Commit the opt-out.
 *
 * NX (rather than a check-then-set) closes the race where two concurrent
 * inbound callbacks for the same contact both observe "no pending" and both
 * send a prompt. NX also means a second keyword never extends the window, the
 * original 30-minute deadline stands, which is exactly the confirmation semantics
 * we want.
 */
export async function tryStartPendingOptOut(
  sessionId: string,
  e164: string,
  keyword: string,
): Promise<boolean> {
  const redis = getRedis();
  const value: PendingOptOut = { keyword, at: new Date().toISOString() };
  const reply = await redis.set(
    pendingKey(sessionId, e164),
    JSON.stringify(value),
    'EX',
    OPTOUT_CONFIRM_TTL_SECONDS,
    'NX',
  );
  return reply === 'OK';
}

/** Remove the pending request (called once the opt-out is confirmed). */
export async function clearPendingOptOut(sessionId: string, e164: string): Promise<void> {
  const redis = getRedis();
  await redis.del(pendingKey(sessionId, e164));
}

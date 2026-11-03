/**
 * Pairing-invite token issuance and verification.
 *
 * Mirrors `api-key.ts` exactly (same crypto primitives, same `SERVER_PEPPER`
 * usage) but with a distinct prefix so the two token types can never be
 * confused or cross-verified. Unlike `api-key.ts`, `verifyInvite` also owns
 * the lookup step (there is no separate authenticate() call site for the
 * public `/pair` routes to compose it from), so it depends on the pairing
 * invite repository.
 *
 * Format (shown to the admin ONCE on creation):
 *   hmd_pi_<secret>
 *
 * Where `secret` = base64url(32 random bytes) [43 chars, no padding].
 *
 * Storage:
 *   - `lookupHash` = HMAC-SHA256(SERVER_PEPPER, full-secret-bytes)
 *                    used to find the row by exact constant-time equality
 *   - `tokenHash`  = argon2id(full-secret-bytes)
 *                    used to VERIFY on each request (slow, resists stolen-hash
 *                    offline attack)
 *
 * The raw token is never persisted, only the two hashes above.
 */
import 'server-only';
import argon2 from 'argon2';
import { createHmac, randomBytes } from 'node:crypto';
import { env } from './env';
import { findInviteByLookupHash, type PairingInviteDoc } from './repositories/pairing-invites';

const PREFIX = 'hmd_pi_';

const ARGON2_OPTS = {
  type: argon2.argon2id,
  memoryCost: 19_456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
} as const;

export interface IssuedPairingInvite {
  plaintext: string; // full token, show once
  lookupHash: string; // hex
  tokenHash: string; // argon2 PHC string
}

export async function issueInvite(): Promise<IssuedPairingInvite> {
  const secretBytes = randomBytes(32);
  const secretB64 = secretBytes.toString('base64url');
  const plaintext = `${PREFIX}${secretB64}`;
  const lookupHash = hmacPepper(secretBytes);
  const tokenHash = await argon2.hash(secretBytes, ARGON2_OPTS);
  return { plaintext, lookupHash, tokenHash };
}

/**
 * Parse a raw pairing-invite token, returning its secret bytes and lookup
 * hash. Returns null for any syntactic issue (never throws on malformed
 * input).
 */
function parseInviteToken(plaintext: string): { secret: Buffer; lookupHash: string } | null {
  if (typeof plaintext !== 'string') return null;
  if (!plaintext.startsWith(PREFIX)) return null;
  const rest = plaintext.slice(PREFIX.length);
  if (!/^[A-Za-z0-9_-]{43}$/.test(rest)) return null;
  let secret: Buffer;
  try {
    secret = Buffer.from(rest, 'base64url');
  } catch {
    return null;
  }
  if (secret.length !== 32) return null;
  return { secret, lookupHash: hmacPepper(secret) };
}

/**
 * Full verification flow for a raw `/pair/<token>` token: parse → O(1) lookup
 * by HMAC hash → argon2 verify against the stored hash. Returns the invite
 * doc on success, or `null` on any malformed token, unknown lookup hash, or
 * hash mismatch, callers must not distinguish these cases in their response
 * (avoids an existence oracle). Never throws.
 */
export async function verifyInvite(plaintext: string): Promise<PairingInviteDoc | null> {
  const parsed = parseInviteToken(plaintext);
  if (!parsed) return null;

  const doc = await findInviteByLookupHash(parsed.lookupHash);
  if (!doc) return null;

  try {
    const ok = await argon2.verify(doc.tokenHash, parsed.secret);
    return ok ? doc : null;
  } catch {
    return null;
  }
}

function hmacPepper(secret: Buffer): string {
  const key = Buffer.from(env.SERVER_PEPPER, 'base64');
  return createHmac('sha256', key).update(secret).digest('hex');
}

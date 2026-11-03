/**
 * API key issuance and verification.
 *
 * Format (shown to user ONCE on creation):
 *   hmd_sk_<division>_<env>_<secret>
 *
 * Where:
 *   - `division` ∈ { developments, payments, core, … }
 *   - `env` ∈ { test, live }
 *   - `secret` = base64url(32 random bytes)  [43 chars, no padding]
 *
 * Storage:
 *   - `keyId`         public short id  = `hmd_sk_<division>_<env>_<first-8-of-hex-sha256(secret)>`
 *                      used as a stable handle in logs & UI
 *   - `keyLookupHash` = HMAC-SHA256(SERVER_PEPPER, full-secret-bytes)
 *                      used to find the row by exact constant-time equality
 *   - `keyHash`       = argon2id(full-secret-bytes)
 *                      used to VERIFY on each request (slow, resists stolen-hash offline attack)
 *
 * Rationale: lookup by HMAC gives O(1) lookup with pepper-dependent secrecy.
 * argon2 verification gives offline-attack resistance even if the DB leaks.
 */
import 'server-only';
import argon2 from 'argon2';
import { createHmac, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { env } from './env';

const ARGON2_OPTS = {
  type: argon2.argon2id,
  memoryCost: 19_456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
} as const;

export interface IssuedApiKey {
  plaintext: string; // full key, show once
  keyId: string; // public handle
  keyLookupHash: string; // hex
  keyHash: string; // argon2 PHC string
}

export async function issueApiKey(params: {
  division: string;
  env: 'test' | 'live';
}): Promise<IssuedApiKey> {
  const division = sanitiseSegment(params.division);
  const e = params.env;
  const secretBytes = randomBytes(32);
  const secretB64 = secretBytes.toString('base64url');
  const plaintext = `hmd_sk_${division}_${e}_${secretB64}`;
  const shortId = createHash('sha256').update(secretBytes).digest('hex').slice(0, 8);
  const keyId = `hmd_sk_${division}_${e}_${shortId}`;
  const keyLookupHash = hmacPepper(secretBytes);
  const keyHash = await argon2.hash(secretBytes, ARGON2_OPTS);
  return { plaintext, keyId, keyLookupHash, keyHash };
}

/**
 * Parse a bearer key, returning the raw 32-byte secret and its lookup hash.
 * Returns null for any syntactic issue (never throws on malformed input).
 */
export function parseKey(plaintext: string): {
  secret: Buffer;
  lookupHash: string;
  division: string;
  env: 'test' | 'live';
} | null {
  if (typeof plaintext !== 'string') return null;
  const m = /^hmd_sk_([a-z0-9]+)_(test|live)_([A-Za-z0-9_-]{43})$/.exec(plaintext);
  if (!m) return null;
  const division = m[1]!;
  const env = m[2]! as 'test' | 'live';
  let secret: Buffer;
  try {
    secret = Buffer.from(m[3]!, 'base64url');
  } catch {
    return null;
  }
  if (secret.length !== 32) return null;
  return { secret, lookupHash: hmacPepper(secret), division, env };
}

export async function verifyKey(plaintextSecret: Buffer, storedHash: string): Promise<boolean> {
  try {
    return await argon2.verify(storedHash, plaintextSecret);
  } catch {
    return false;
  }
}

function hmacPepper(secret: Buffer): string {
  const key = Buffer.from(env.SERVER_PEPPER, 'base64');
  return createHmac('sha256', key).update(secret).digest('hex');
}

function sanitiseSegment(s: string): string {
  const cleaned = s.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!cleaned) throw new Error('invalid division segment');
  return cleaned;
}

/** Constant-time hex comparison utility. */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

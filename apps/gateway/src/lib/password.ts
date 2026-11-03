/**
 * Password hashing using Node's built-in scrypt (no native deps).
 *
 * PHC-like format we store in env:
 *   scrypt$N$r$p$<saltB64>$<keyB64>
 *
 * N, r, p are scrypt cost parameters. Keys are 32 bytes.
 */
import 'server-only';
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: Buffer,
  keylen: number,
  opts: { N: number; r: number; p: number; maxmem?: number },
) => Promise<Buffer>;

const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 32;
const MAXMEM = 64 * 1024 * 1024;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
  let salt: Buffer;
  let key: Buffer;
  try {
    salt = Buffer.from(parts[4]!, 'base64');
    key = Buffer.from(parts[5]!, 'base64');
  } catch {
    return false;
  }
  const derived = await scryptAsync(password, salt, key.length, { N: n, r, p, maxmem: MAXMEM });
  if (derived.length !== key.length) return false;
  return timingSafeEqual(derived, key);
}

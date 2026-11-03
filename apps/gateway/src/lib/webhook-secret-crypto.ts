/**
 * AES-256-GCM encryption for per-route webhook signing secrets.
 *
 * The secret is generated as 32 random bytes (base64url) and shown to the
 * admin exactly once on route creation. To deliver a webhook later, the cron
 * worker needs to recompute an HMAC over the raw payload, so the gateway
 * must be able to recover the raw secret. We therefore encrypt-at-rest using
 * a server-side key (`WEBHOOK_DELIVERY_KEY`, 32 bytes base64) rather than
 * argon2-hashing.
 *
 * This is a signing secret, not an authentication credential, defence in
 * depth via argon2 buys little here, since whoever can decrypt the at-rest
 * blob can also forge signatures regardless. We document the trade-off in
 * the route doc itself (`secretFingerprint` is the only public identifier).
 */
import 'server-only';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from './env';

const ALGO = 'aes-256-gcm';

function key(): Buffer {
  return Buffer.from(env.WEBHOOK_DELIVERY_KEY, 'base64');
}

export interface SealedSecret {
  ciphertext: string; // base64
  iv: string; // base64 (12 bytes)
  authTag: string; // base64 (16 bytes)
}

export function sealSecret(plaintext: string): SealedSecret {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    ciphertext: ct.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
  };
}

export function openSecret(sealed: SealedSecret): string {
  const iv = Buffer.from(sealed.iv, 'base64');
  const ct = Buffer.from(sealed.ciphertext, 'base64');
  const authTag = Buffer.from(sealed.authTag, 'base64');
  const decipher = createDecipheriv(ALGO, key(), iv);
  decipher.setAuthTag(authTag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString('utf8');
}

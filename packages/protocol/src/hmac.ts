/**
 * HMAC-SHA256 signing and verification for gateway ↔ worker envelopes.
 * The signed payload is the canonical-JSON of the envelope WITH `sig`
 * replaced by an empty string. This avoids chicken-and-egg on the sig field.
 *
 * We use node:crypto via a dynamic import so this module can also be bundled
 * for a pure-browser context if ever needed (none today, workers only).
 */
import { canonicalJson } from './canonical.js';

async function getHmac(): Promise<
  (algo: 'sha256', key: Uint8Array) => { update: (s: string) => { digest: (enc: 'hex') => string } }
> {
  // Node 20 'node:crypto'
  const mod = await import('node:crypto');
  return mod.createHmac as any;
}

export async function signEnvelope<T extends { sig: string }>(
  envelope: T,
  secret: Uint8Array,
): Promise<T> {
  const createHmac = await getHmac();
  const payload = canonicalJson({ ...envelope, sig: '' });
  const sig = createHmac('sha256', secret).update(payload).digest('hex');
  return { ...envelope, sig };
}

export async function verifyEnvelope<T extends { sig: string }>(
  envelope: T,
  secret: Uint8Array,
): Promise<boolean> {
  const createHmac = await getHmac();
  const payload = canonicalJson({ ...envelope, sig: '' });
  const expected = createHmac('sha256', secret).update(payload).digest('hex');
  return timingSafeEqualHex(expected, envelope.sig);
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

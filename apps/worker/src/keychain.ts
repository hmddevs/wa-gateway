/**
 * Keychain-backed AES-256-GCM for Baileys session files.
 *
 * We keep a 32-byte key in the macOS login keychain (account=`hmd-wa.core`,
 * service=`hmd-wa-session`). On first run, generate + store. On every run,
 * read to a Buffer in memory. The key never touches disk.
 *
 * The Baileys multi-file auth state is encrypted on write, decrypted on
 * read, and kept under ~/Library/Application Support/hmd-wa/session/ as
 * `<file>.enc` (each entry IV||ciphertext||tag).
 */
import { spawnSync } from 'node:child_process';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

const SERVICE = 'hmd-wa-session';

function security(args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync('security', args, { encoding: 'utf8' });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

export function loadOrCreateKey(sessionId: string): Buffer {
  // Linux/server path: a 32-byte key supplied as 64 hex chars via env. When set,
  // it is the single source of truth and the macOS Keychain is never touched.
  const envKey = process.env.HMD_WA_SESSION_KEY?.trim();
  if (envKey) {
    if (!/^[0-9a-f]{64}$/i.test(envKey)) {
      throw new Error('HMD_WA_SESSION_KEY must be 64 hex characters (32 bytes for AES-256-GCM)');
    }
    return Buffer.from(envKey, 'hex');
  }

  // macOS path: derive the key from the login Keychain (unchanged).
  const account = `hmd-wa.core.${sessionId}`;
  // Try to read.
  const get = security(['find-generic-password', '-a', account, '-s', SERVICE, '-w']);
  if (get.status === 0) {
    const hex = get.stdout.trim();
    if (/^[0-9a-f]{64}$/i.test(hex)) return Buffer.from(hex, 'hex');
  }
  // Create a new key.
  const key = randomBytes(32);
  const add = security([
    'add-generic-password',
    '-a',
    account,
    '-s',
    SERVICE,
    '-w',
    key.toString('hex'),
    '-U',
    '-T',
    '/usr/bin/security', // pre-authorise security CLI so reads never prompt
  ]);
  if (add.status !== 0) {
    throw new Error(`Keychain add failed for session ${sessionId}: ${add.stderr}`);
  }
  return key;
}

export function encrypt(key: Buffer, plaintext: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ct, tag]);
}

export function decrypt(key: Buffer, blob: Buffer): Buffer {
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(blob.length - 16);
  const ct = blob.subarray(12, blob.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

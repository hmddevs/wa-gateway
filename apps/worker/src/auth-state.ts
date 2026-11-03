/**
 * Encrypted multi-file auth state for Baileys.
 *
 * Baileys' `useMultiFileAuthState` stores creds.json and thousands of
 * `session-*.json` files. We wrap the underlying fs with AES-256-GCM so
 * anything touching disk is encrypted.
 *
 * The on-disk filename equals the base64url of the logical key; the
 * contents are the encrypted JSON blob.
 */
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  unlinkSync,
  renameSync,
  openSync,
  fsyncSync,
  closeSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  initAuthCreds,
  BufferJSON,
  proto,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataTypeMap,
} from '@whiskeysockets/baileys';
import { encrypt, decrypt } from './keychain.js';

export function sessionDir(sessionId: string): string {
  // Linux/server path: honour an explicit base dir on the mounted volume. Each
  // session nests under it, matching the macOS layout. When unset, fall back to
  // the macOS Application Support location (unchanged behaviour).
  const base = process.env.WA_SESSION_DIR?.trim();
  if (base) {
    return join(base, 'sessions', sessionId);
  }
  return join(homedir(), `Library/Application Support/hmd-wa/sessions/${sessionId}`);
}

function keyToFile(dir: string, key: string): string {
  const safe = Buffer.from(key, 'utf8').toString('base64url');
  return join(dir, `${safe}.enc`);
}

function readJson<T>(key: Buffer, file: string): T | null {
  if (!existsSync(file)) return null;
  const blob = readFileSync(file);
  const plain = decrypt(key, blob);
  return JSON.parse(plain.toString('utf8'), BufferJSON.reviver) as T;
}

/**
 * Atomic encrypted write: write to a temp file → fsync → rename.
 *
 * Why: a plain `writeFileSync` is not atomic. If launchd kills the worker
 * mid-write during macOS reboot, the on-disk file is truncated/corrupt.
 * Baileys then reads back partial creds, treats it as a fresh device, and
 * forces a QR re-pair. POSIX `rename` is atomic, either the new content is
 * visible or the old one is, never a half-written blob. `fsync` before
 * rename guarantees the bytes are on stable storage before we swap.
 */
function writeJson(key: Buffer, file: string, value: unknown): void {
  const plain = Buffer.from(JSON.stringify(value, BufferJSON.replacer), 'utf8');
  const blob = encrypt(key, plain);
  const tmp = `${file}.tmp-${process.pid}`;
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeFileSync(fd, blob);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
}

/**
 * First-pair flag, read via `getFirstPairCompletedAt`, written via
 * `setFirstPairCompletedAt`. Persisted under the same encrypted-file pattern
 * as the auth state so it survives worker restarts. Stored as
 * `{ ts: ISO8601 }` so future fields can extend the same blob without a
 * migration. Missing file → `undefined`. The flag is set ONCE, after a
 * successful history-sync completes; if the sync fails midway, the flag
 * stays unset so the next pair retries.
 */
const FIRST_PAIR_KEY = 'first-pair';

export function getFirstPairCompletedAt(encKey: Buffer, sessionId: string): string | undefined {
  const dir = sessionDir(sessionId);
  const file = keyToFile(dir, FIRST_PAIR_KEY);
  const v = readJson<{ ts?: string }>(encKey, file);
  return v?.ts;
}

export function setFirstPairCompletedAt(encKey: Buffer, sessionId: string, ts: string): void {
  const dir = sessionDir(sessionId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = keyToFile(dir, FIRST_PAIR_KEY);
  writeJson(encKey, file, { ts });
}

export async function useEncryptedAuthState(
  encKey: Buffer,
  sessionId: string,
): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> {
  const dir = sessionDir(sessionId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const credsFile = keyToFile(dir, 'creds');

  const creds: AuthenticationCreds =
    readJson<AuthenticationCreds>(encKey, credsFile) ?? initAuthCreds();

  const state: AuthenticationState = {
    creds,
    keys: {
      get: async (type, ids) => {
        const result: { [k: string]: SignalDataTypeMap[typeof type] } = {};
        await Promise.all(
          ids.map(async (id) => {
            const file = keyToFile(dir, `${type}-${id}`);
            let value = readJson<unknown>(encKey, file);
            if (type === 'app-state-sync-key' && value) {
              value = proto.Message.AppStateSyncKeyData.create(value as Record<string, unknown>);
            }
            if (value) result[id] = value as SignalDataTypeMap[typeof type];
          }),
        );
        return result;
      },
      set: async (data) => {
        const tasks: Promise<void>[] = [];
        for (const category of Object.keys(data) as (keyof SignalDataTypeMap)[]) {
          const items = data[category] as Record<string, unknown> | undefined;
          if (!items) continue;
          for (const id of Object.keys(items)) {
            const file = keyToFile(dir, `${category}-${id}`);
            const value = items[id];
            tasks.push(
              Promise.resolve().then(() => {
                if (value == null) {
                  if (existsSync(file)) unlinkSync(file);
                } else {
                  writeJson(encKey, file, value);
                }
              }),
            );
          }
        }
        await Promise.all(tasks);
      },
    },
  };

  return {
    state,
    saveCreds: async () => {
      writeJson(encKey, credsFile, creds);
    },
  };
}

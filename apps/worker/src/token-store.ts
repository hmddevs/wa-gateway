/**
 * Refresh-token persistence.
 *
 * The worker rotates its refresh token on a gateway 401 (see
 * `gateway-client.ts` -> `rotateToken`). The rotated value MUST survive a
 * restart, otherwise the worker boots with the stale bootstrap token and can no
 * longer re-authenticate.
 *
 * Two persistence backends, chosen by config:
 *   - Linux/server: a single file on the mounted volume (`HMD_WA_TOKEN_FILE`, or a
 *     `refresh-token` file alongside the session dir). Written atomically
 *     (temp + rename), mode 0o600. Preferred over the env-supplied bootstrap
 *     token on boot when present and non-empty.
 *   - macOS: the legacy `config.json` rewrite (handled in `index.ts`), used as
 *     the fallback when the volume envs are unset.
 *
 * `resolveTokenFile` returns the file path on the Linux path, or `null` when
 * neither `HMD_WA_TOKEN_FILE` nor `WA_SESSION_DIR` is set (macOS path).
 */
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { WorkerConfig } from './config.js';

/**
 * Resolve the volume-backed token file, or `null` for the macOS path.
 * Precedence: explicit `tokenFile` > `<sessionDir>/refresh-token`.
 */
export function resolveTokenFile(cfg: WorkerConfig): string | null {
  if (cfg.tokenFile && cfg.tokenFile.trim()) return cfg.tokenFile.trim();
  if (cfg.sessionDir && cfg.sessionDir.trim()) {
    return join(cfg.sessionDir.trim(), 'refresh-token');
  }
  return null;
}

/** Read a persisted token, or `null` if the file is absent or empty. */
export function readPersistedToken(file: string): string | null {
  if (!existsSync(file)) return null;
  const tok = readFileSync(file, 'utf8').trim();
  return tok.length > 0 ? tok : null;
}

/** Atomically persist a token (temp file + rename), mode 0o600. */
export function writePersistedToken(file: string, token: string): void {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, token, { mode: 0o600 });
  renameSync(tmp, file);
}

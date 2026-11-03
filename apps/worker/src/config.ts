/**
 * Worker configuration sources (in order of precedence):
 *   1. Environment variables (`HMD_WA_*`)
 *   2. `~/Library/Application Support/hmd-wa/config.json`, if present, as a fallback
 *
 * Required fields: gatewayBaseUrl, workerId, refreshToken, wireSecretB64, upstashRedisUrl.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';

const ConfigSchema = z.object({
  gatewayBaseUrl: z.string().url(),
  workerId: z.string().min(1).default('primary'),
  refreshToken: z.string().min(20),
  wireSecretB64: z.string().min(16),
  upstashRedisUrl: z.string().startsWith('rediss://'),
  loopbackPort: z.number().int().min(1024).max(65_535).default(7823),
  logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  /**
   * Optional URL the worker POSTs to when a pairing scan is required, fired from autoResetSession after WA invalidates the session. Body:
   * `{ event: 'pairing_required', sessionId, workerId, gatewayBaseUrl, ts }`.
   * Point it at a Telegram bot's sendMessage URL, a Discord webhook, an
   * n8n / Zapier trigger, anything that accepts a JSON POST. Unset means
   * no notification (admin UI is the only surface for the new QR).
   */
  notifyWebhookUrl: z.string().url().optional(),
  // Linux/server-only fields. All optional: when unset, the worker behaves exactly
  // as it did on macOS (Keychain-derived key, ~/Library session dir, config.json
  // token persistence). `sessionKey` is consumed directly by keychain.ts, which
  // fails loud if neither it nor the Keychain yields a key.
  sessionKey: z.string().optional(),
  sessionDir: z.string().optional(),
  tokenFile: z.string().optional(),
});

export type WorkerConfig = z.infer<typeof ConfigSchema>;

export function configPath(): string {
  return join(homedir(), 'Library/Application Support/hmd-wa/config.json');
}

export function loadConfig(): WorkerConfig {
  const fileRaw = existsSync(configPath()) ? JSON.parse(readFileSync(configPath(), 'utf8')) : {};
  const merged = {
    gatewayBaseUrl: process.env.HMD_WA_GATEWAY ?? fileRaw.gatewayBaseUrl,
    workerId: process.env.HMD_WA_WORKER_ID ?? fileRaw.workerId,
    refreshToken: process.env.HMD_WA_REFRESH_TOKEN ?? fileRaw.refreshToken,
    wireSecretB64: process.env.HMD_WA_WIRE_SECRET ?? fileRaw.wireSecretB64,
    upstashRedisUrl: process.env.HMD_WA_REDIS ?? fileRaw.upstashRedisUrl,
    loopbackPort: Number(process.env.HMD_WA_PORT ?? fileRaw.loopbackPort ?? 7823),
    logLevel: (process.env.HMD_WA_LOG_LEVEL ??
      fileRaw.logLevel ??
      'info') as WorkerConfig['logLevel'],
    notifyWebhookUrl: process.env.HMD_WA_NOTIFY_WEBHOOK_URL ?? fileRaw.notifyWebhookUrl,
    sessionKey: process.env.HMD_WA_SESSION_KEY ?? fileRaw.sessionKey,
    sessionDir: process.env.WA_SESSION_DIR ?? fileRaw.sessionDir,
    tokenFile: process.env.HMD_WA_TOKEN_FILE ?? fileRaw.tokenFile,
  };
  return ConfigSchema.parse(merged);
}

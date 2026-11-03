/**
 * HMD WA Baileys Worker, entrypoint.
 *
 * Lifecycle:
 *   1. Load config (file or env).
 *   2. Start SessionManager (fetches sessions from gateway, boots one Baileys
 *      runtime per session, subscribes to control channel).
 *   3. Start loopback Fastify UI at 127.0.0.1:<port>.
 *   4. Graceful shutdown on SIGINT/SIGTERM.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import pino from 'pino';
import { loadConfig, configPath } from './config.js';
import { SessionManager } from './session-manager.js';
import { startLoopback } from './loopback-ui.js';
import { resolveTokenFile, readPersistedToken, writePersistedToken } from './token-store.js';

async function main() {
  const cfg = loadConfig();
  const log = pino({ level: cfg.logLevel, base: { app: 'hmd-wa-worker' } });
  const wireSecret = Buffer.from(cfg.wireSecretB64, 'base64');

  // Boot-precedence: on the Linux/server path a previously rotated token persisted
  // to the volume wins over the (possibly stale) bootstrap value in env. macOS
  // (no volume envs) keeps using the config.json-merged token untouched.
  const tokenFile = resolveTokenFile(cfg);
  if (tokenFile) {
    const persisted = readPersistedToken(tokenFile);
    if (persisted && persisted !== cfg.refreshToken) {
      log.info({ tokenFile }, 'using persisted refresh token from volume');
      cfg.refreshToken = persisted;
    }
  }

  log.info({ workerId: cfg.workerId, gateway: cfg.gatewayBaseUrl }, 'worker starting');

  const onTokenRotate = (newToken: string) => {
    if (tokenFile) {
      // Linux/server: atomic write to the volume so a restart re-auths with the
      // latest rotated token.
      writePersistedToken(tokenFile, newToken);
      return;
    }
    // macOS: rewrite config.json in place (legacy behaviour).
    mkdirSync(dirname(configPath()), { recursive: true, mode: 0o700 });
    writeFileSync(configPath(), JSON.stringify({ ...cfg, refreshToken: newToken }, null, 2), {
      mode: 0o600,
    });
  };

  const manager = new SessionManager(cfg, wireSecret, onTokenRotate);
  await manager.start();
  const ui = await startLoopback(manager, cfg.loopbackPort);
  log.info({ port: cfg.loopbackPort }, `loopback UI: http://127.0.0.1:${cfg.loopbackPort}`);

  const shutdown = async (sig: string) => {
    log.info({ sig }, 'shutting down');
    await ui.close().catch(() => {});
    await manager.stop().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('fatal', err);
  process.exit(1);
});

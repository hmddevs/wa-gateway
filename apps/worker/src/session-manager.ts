/**
 * Session manager, owns the pool of BaileysRuntime instances.
 *
 * On start:
 *   1. Fetches the session list from the gateway.
 *   2. Boots one BaileysRuntime per session.
 *   3. Subscribes to `wa:control:<workerId>` for runtime add/remove commands.
 *
 * Control envelope shape (HMAC-signed, same wire format as outbound):
 *   { kind: 'control', action: 'start_session'|'stop_session'|'restart'|'ping',
 *     sessionId?: string, nonce: string, at: string, sig: string }
 *
 * Nonce dedup uses an in-process FIFO set (max 10,000) as defence-in-depth;
 * the gateway is expected to dedup against Redis already.
 */
import pino from 'pino';
import Redis from 'ioredis';
import type { WorkerConfig } from './config.js';
import { GatewayClient, type TokenStore } from './gateway-client.js';
import { BaileysRuntime, type RuntimeEvents } from './baileys-runtime.js';

interface ControlEnvelope {
  type: 'control';
  action: 'start_session' | 'stop_session' | 'restart' | 'ping';
  sessionId?: string;
  nonce: string;
  at: string;
  sig: string;
}

const MAX_NONCE_SET = 10_000;

/**
 * Period for the session-drift reconciler. Worker only auto-syncs at boot;
 * thereafter it relies on `wa:control:<workerId>` real-time messages. If a
 * `start_session` or `stop_session` is missed (Redis blip, gateway 5xx, race),
 * the worker drifts from the gateway's view and either runs an orphan session
 * (wasting WhatsApp pairing-rate-limit budget on a phantom QR loop, as seen
 * 2026-05-10 with another session) or fails to serve a session that the gateway thinks
 * exists. 5 minutes is small enough that drift is short-lived and large enough
 * that a healthy session list isn't fetched too often.
 */
export const RECONCILE_INTERVAL_MS = 5 * 60_000;

/**
 * Cadence for proactive worker-token rotation. The refresh JWT has a 30-day
 * TTL and is otherwise only rotated reactively on a 401, but in steady state
 * callbacks succeed, so nothing ever triggers a rotate and the token silently
 * ages out. Once it expires the worker can't refresh it (the refresh endpoint
 * itself rejects the expired token), and every callback + heartbeat 401s: the
 * worker still delivers WhatsApp messages but the gateway never marks them
 * sent and shows the worker offline. Rotating every 12h keeps the token far
 * from its expiry so that cliff is never reached. (Incident 2026-06-24.)
 */
export const TOKEN_REFRESH_INTERVAL_MS = 12 * 60 * 60_000;

export interface SessionInfo {
  sessionId: string;
  status: 'offline' | 'pairing' | 'connected' | 'degraded';
  phoneE164: string | null;
  latestQr: string | null;
}

export class SessionManager {
  private readonly logger: pino.Logger;
  private readonly controlClient: GatewayClient;
  /** One holder shared by the control client and every per-session client so a
   *  single rotation propagates to all of them at once. */
  private readonly tokenStore: TokenStore;
  private readonly controlRedis: Redis;
  private readonly runtimes = new Map<string, BaileysRuntime>();
  private readonly seenNonces: string[] = [];
  private reconcileTimer: NodeJS.Timeout | null = null;
  private tokenRefreshTimer: NodeJS.Timeout | null = null;
  /** Set in `stop()` so the `'ready'` handler doesn't re-subscribe during shutdown. */
  private stopping = false;

  constructor(
    private readonly cfg: WorkerConfig,
    private readonly wireSecret: Buffer,
    private readonly onTokenRotate: (tok: string) => void,
  ) {
    this.logger = pino({ level: cfg.logLevel, base: { app: 'hmd-wa-worker' } });
    this.tokenStore = { token: cfg.refreshToken };
    this.controlClient = new GatewayClient({
      baseUrl: cfg.gatewayBaseUrl,
      refreshToken: cfg.refreshToken,
      tokenStore: this.tokenStore,
      wireSecret,
      onTokenRotate,
    });
    this.controlRedis = new Redis(cfg.upstashRedisUrl, {
      tls: {},
      lazyConnect: true,
      maxRetriesPerRequest: 2,
      // Keep the socket warm and reconnect forever with capped backoff, Upstash
      // drops idle/half-open connections server-side, and a control channel that
      // silently dies leaves the worker deaf to start/stop/restart commands.
      keepAlive: 30_000,
      retryStrategy: (times: number) => Math.min(times * 500, 10_000),
    });
    this.controlRedis.on('error', (err: Error) =>
      this.logger.error({ workerId: cfg.workerId, err: err.message }, 'control redis error'),
    );
    this.controlRedis.on('close', () =>
      this.logger.warn({ workerId: cfg.workerId }, 'control redis connection closed'),
    );
    this.controlRedis.on('end', () =>
      this.logger.warn({ workerId: cfg.workerId }, 'control redis connection ended'),
    );
    this.controlRedis.on('reconnecting', () =>
      this.logger.warn({ workerId: cfg.workerId }, 'control redis reconnecting'),
    );
    this.controlRedis.on('ready', () => {
      this.logger.info({ workerId: cfg.workerId }, 'control redis ready');
      if (!this.stopping) {
        // Re-issue the control subscription after any (re)connect. Idempotent.
        this.controlRedis
          .subscribe(`wa:control:${cfg.workerId}`)
          .catch((err: Error) =>
            this.logger.error(
              { workerId: cfg.workerId, err: err.message },
              'control re-subscribe on ready failed',
            ),
          );
      }
    });
  }

  async start(): Promise<void> {
    const { sessions } = await this.controlClient.getSessions();
    this.logger.info({ count: sessions.length }, 'fetched session list from gateway');

    for (const { sessionId } of sessions) {
      await this.startSession(sessionId);
    }

    await this.controlRedis.connect();
    await this.controlRedis.subscribe(`wa:control:${this.cfg.workerId}`);
    this.controlRedis.on('message', (_channel, message) => {
      this.handleControlMessage(message).catch((err) =>
        this.logger.error({ err: err.message }, 'handleControlMessage failed'),
      );
    });

    this.logger.info({ workerId: this.cfg.workerId }, 'control channel subscribed');

    this.reconcileTimer = setInterval(() => {
      this.reconcile().catch((err) =>
        this.logger.warn({ err: (err as Error).message }, 'reconcile failed, will retry next tick'),
      );
    }, RECONCILE_INTERVAL_MS);
    // Don't keep the event loop alive for this timer alone.
    this.reconcileTimer.unref?.();

    this.startTokenRefresh();
  }

  /**
   * Proactively rotate the worker's refresh token so the 30-day JWT never
   * reaches its expiry cliff (see TOKEN_REFRESH_INTERVAL_MS). Rotates once
   * shortly after boot, so a worker that was down for a long stretch gets a
   * fresh 30-day window immediately, then on a 12h cadence. A failure here is
   * logged loudly but never throws: if the token is already expired only a
   * re-bootstrap can recover it, and crashing the manager wouldn't help.
   */
  private startTokenRefresh(): void {
    const rotate = (): Promise<void> =>
      this.controlClient.rotateToken().then(
        () => this.logger.info({ workerId: this.cfg.workerId }, 'worker token proactively rotated'),
        (err: Error) =>
          this.logger.error(
            { workerId: this.cfg.workerId, err: err.message },
            'proactive token refresh failed, token may be expired; re-bootstrap required',
          ),
      );
    void rotate();
    this.tokenRefreshTimer = setInterval(() => void rotate(), TOKEN_REFRESH_INTERVAL_MS);
    this.tokenRefreshTimer.unref?.();
  }

  /**
   * Reconcile in-memory runtimes against the gateway's authoritative session
   * list. Called periodically to close the missed-control-message gap.
   *
   *   - Gateway has session, worker doesn't → start it.
   *   - Worker has session, gateway doesn't → stop it.
   *
   * Returns counts so callers (tests, future health endpoint) can observe the
   * sweep result without grepping logs.
   */
  async reconcile(): Promise<{ started: number; stopped: number; gatewaySize: number }> {
    const { sessions } = await this.controlClient.getSessions();
    const expected = new Set(sessions.map((s) => s.sessionId));
    const local = new Set(this.runtimes.keys());

    let started = 0;
    let stopped = 0;

    for (const sessionId of expected) {
      if (!local.has(sessionId)) {
        this.logger.warn({ sessionId }, 'reconcile: gateway has session worker missed, starting');
        await this.startSession(sessionId);
        started += 1;
      }
    }
    for (const sessionId of local) {
      if (!expected.has(sessionId)) {
        this.logger.warn({ sessionId }, 'reconcile: worker has orphan session, stopping');
        await this.stopSession(sessionId);
        stopped += 1;
      }
    }

    if (started + stopped > 0) {
      this.logger.info(
        { started, stopped, gatewaySize: expected.size, localSize: this.runtimes.size },
        'reconcile sweep completed',
      );
    }
    return { started, stopped, gatewaySize: expected.size };
  }

  async startSession(sessionId: string): Promise<void> {
    // Stop any existing runtime for this session before replacing it.
    if (this.runtimes.has(sessionId)) {
      this.logger.info({ sessionId }, 'stopping existing runtime before restart');
      await this.stopSession(sessionId);
    }

    const events: RuntimeEvents = {
      onStatusChange: (s) => this.logger.info({ sessionId, status: s }, 'session status changed'),
      onQr: () => this.logger.info({ sessionId }, 'new pairing QR for session'),
    };

    const runtime = new BaileysRuntime(
      this.cfg,
      sessionId,
      this.wireSecret,
      events,
      this.onTokenRotate,
      this.tokenStore,
    );

    this.runtimes.set(sessionId, runtime);
    await runtime.start();
    this.logger.info({ sessionId }, 'session started');
  }

  async stopSession(sessionId: string): Promise<void> {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) {
      this.logger.warn({ sessionId }, 'stopSession called for unknown session, ignored');
      return;
    }
    await runtime.stop();
    this.runtimes.delete(sessionId);
    this.logger.info({ sessionId }, 'session stopped');
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    if (this.tokenRefreshTimer) {
      clearInterval(this.tokenRefreshTimer);
      this.tokenRefreshTimer = null;
    }
    const stopAll = Array.from(this.runtimes.keys()).map((id) => this.stopSession(id));
    await Promise.allSettled(stopAll);
    this.controlRedis.disconnect();
    this.logger.info('session manager stopped');
  }

  allSessions(): SessionInfo[] {
    return Array.from(this.runtimes.entries()).map(([sessionId, runtime]) => ({
      sessionId,
      status: runtime.currentStatus,
      phoneE164: runtime.pairedPhone,
      latestQr: runtime.latestQr,
    }));
  }

  private async handleControlMessage(message: string): Promise<void> {
    let env: ControlEnvelope;
    try {
      env = JSON.parse(message) as ControlEnvelope;
    } catch {
      this.logger.warn('control message not valid JSON, dropped');
      return;
    }

    if (env.type !== 'control') {
      this.logger.warn(
        { type: (env as { type?: string }).type },
        'control message has wrong type field, dropped',
      );
      return;
    }

    // Timestamp freshness check (±60s).
    const delta = Math.abs(Date.now() - Date.parse(env.at));
    if (!Number.isFinite(delta) || delta > 60_000) {
      this.logger.warn({ action: env.action }, 'stale control message timestamp, dropped');
      return;
    }

    // HMAC verification.
    if (!this.controlClient.verifyInbound(env)) {
      this.logger.warn({ action: env.action }, 'bad control message signature, dropped');
      return;
    }

    // Nonce dedup (in-process FIFO set).
    if (this.seenNonces.includes(env.nonce)) {
      this.logger.info({ action: env.action }, 'duplicate control nonce, skipped');
      return;
    }
    this.seenNonces.push(env.nonce);
    if (this.seenNonces.length > MAX_NONCE_SET) {
      this.seenNonces.shift();
    }

    switch (env.action) {
      case 'start_session': {
        if (!env.sessionId) {
          this.logger.warn('start_session control message missing sessionId, ignored');
          return;
        }
        this.logger.info({ sessionId: env.sessionId }, 'control: start_session');
        await this.startSession(env.sessionId);
        break;
      }
      case 'stop_session': {
        if (!env.sessionId) {
          this.logger.warn('stop_session control message missing sessionId, ignored');
          return;
        }
        this.logger.info({ sessionId: env.sessionId }, 'control: stop_session');
        await this.stopSession(env.sessionId);
        break;
      }
      case 'restart': {
        if (env.sessionId) {
          this.logger.info({ sessionId: env.sessionId }, 'control: restart session');
          await this.stopSession(env.sessionId);
          await this.startSession(env.sessionId);
        } else {
          this.logger.info('control: restart all sessions');
          const ids = Array.from(this.runtimes.keys());
          for (const id of ids) {
            await this.stopSession(id);
            await this.startSession(id);
          }
        }
        break;
      }
      case 'ping':
        // Intentionally no-op.
        break;
      default: {
        this.logger.warn(
          { action: (env as ControlEnvelope).action },
          'unknown control action, ignored',
        );
      }
    }
  }
}

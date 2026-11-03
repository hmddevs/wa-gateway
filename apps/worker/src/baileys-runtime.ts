/**
 * Baileys runtime, the heart of the worker, parameterised by sessionId.
 *
 * Responsibilities:
 *   - Boot Baileys with the encrypted auth state for this session.
 *   - Forward pairing QR to the gateway callback so the admin UI can render it.
 *   - Emit heartbeat every 15s to gateway, including both workerId and sessionId.
 *   - Receive signed `send` / `react` / `presence` envelopes on
 *     `wa:outbound:<sessionId>`, dedup + clock-check + verify, then perform
 *     the operation via Baileys.
 *   - Emit `send_ack` and receipt envelopes on success/failure/update.
 *   - Forward inbound messages and reactions to the gateway callback.
 *   - Optionally mark inbound messages as read, gated on the per-session
 *     `sendReadReceipts` toggle fetched from the gateway.
 */
import {
  makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  WAMessageStubType,
  proto,
  type GroupMetadata,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import { BoundedCache } from './bounded-cache.js';
import Redis from 'ioredis';
import type { WorkerConfig } from './config.js';
import { loadOrCreateKey } from './keychain.js';
import { renameSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  useEncryptedAuthState,
  getFirstPairCompletedAt,
  setFirstPairCompletedAt,
  sessionDir,
} from './auth-state.js';
import { GatewayClient, type TokenStore } from './gateway-client.js';
import type { SendAckEnvelope } from '@hmddevs/protocol/wire';
import type { GroupMetadata as WireGroupMetadata } from '@hmddevs/protocol/db';
// Type-only imports, no runtime cost; keeps the worker aligned with the
// protocol package's source of truth for tenant / purpose vocabulary.
import type { MessagePurpose, ProjectId } from '@hmddevs/protocol/db';

interface WireSend {
  kind: 'send';
  messageId: string;
  to: string; // E.164 with +
  body:
    | { kind: 'text'; text: string }
    | { kind: 'image'; url: string; caption?: string }
    | { kind: 'document'; url: string; filename?: string; caption?: string };
  channel: string;
  apiKeyId: string;
  requestId: string;
  /**
   * Tenant slug the gateway resolved from the API key, required on the
   * envelope so the worker can emit per-project log context.
   */
  projectId: ProjectId;
  /** Caller-declared intent enum; required, used for log/audit dimensions. */
  purpose: MessagePurpose;
  /** Optional quoted-message reference, surfaces an inline quote on the peer. */
  quoted?: { waMessageId: string; fromMe: boolean; participantJid?: string };
  nonce: string;
  at: string;
  sig: string;
}

interface WireReact {
  kind: 'react';
  messageId: string;
  to: string;
  waJid: string;
  targetWaMessageId: string;
  targetFromMe: boolean;
  emoji: string; // empty string clears
  apiKeyId?: string;
  requestId: string;
  nonce: string;
  at: string;
  sig: string;
}

interface WirePresence {
  kind: 'presence';
  messageId: string;
  state: 'available' | 'unavailable' | 'composing' | 'recording' | 'paused';
  waJid?: string;
  apiKeyId?: string;
  requestId: string;
  nonce: string;
  at: string;
  sig: string;
}

type WireEnvelope = WireSend | WireReact | WirePresence;

/**
 * Inner item shape for `chat_event_batch`. Mirrors `ChatEventBatchItemSchema`
 * in `@hmddevs/protocol`; defined locally so the worker has no compile-time
 * dependency on the protocol package's type-only exports beyond what
 * `gateway-client.ts` already pulls.
 */
interface HistoryEventItem {
  waMessageId: string;
  direction: 'in_history' | 'out_history';
  source: 'history_sync';
  counterpartyJid: string;
  counterpartyE164: string | null;
  content: ReturnType<typeof extractChatEventContent>;
  ts: string;
}

interface ContactItem {
  jid: string;
  e164: string | null;
  pushName: string | null;
  notify: string | null;
  verifiedName: string | null;
  profilePicUrl: string | null;
}

const HEARTBEAT_INTERVAL_MS = 15_000;
const CONFIG_REFRESH_INTERVAL_MS = 30_000;
const PROCESSED_SET_KEY = (sessionId: string) => `wa:processed:${sessionId}`;
const MSG_DEDUP_TTL_S = 7 * 24 * 3600; // 7 days

/** Private per-session round-trip health channel for the half-open detector. */
const HEALTH_CHANNEL = (sessionId: string) => `wa:health:${sessionId}`;
/** How often the half-open detector publishes a nonce and waits for it back.
 *  300s (was 30s), cut to reduce idle Redis chatter (PUBLISH+echo per probe,
 *  ×2 workers, was ~8 ops/min at zero message volume). Trade-off: two
 *  consecutive misses now take ~10 minutes to trigger the self-heal exit
 *  (process.exit for launchd restart), versus ~2 minutes before. Accepted
 *  because the m1 pool failover (PR #111, ~35s) already covers message sends
 *  during that gap, this probe only detects a half-open outbound
 *  subscription, it is not the primary failover mechanism. */
const HEALTH_PROBE_INTERVAL_MS = 300_000;
/** How long to wait for a probe nonce to echo back before declaring it missed. */
const HEALTH_PROBE_TIMEOUT_MS = 5_000;

/**
 * Shared ioredis options for the worker's long-lived connections. Upstash will
 * silently drop idle/half-open connections server-side; `keepAlive` keeps the
 * socket warm and the `retryStrategy` reconnects forever with capped
 * exponential backoff so a worker never gives up on Redis (the half-open
 * detector is the backstop when ioredis itself fails to notice a dead socket).
 */
const REDIS_OPTS = {
  tls: {},
  lazyConnect: true,
  maxRetriesPerRequest: 2,
  keepAlive: 30_000,
  retryStrategy: (times: number) => Math.min(times * 500, 10_000),
} as const;

/** History-sync buffer thresholds. The batch endpoint caps at 500 events; the
 *  idle window is short enough that progress feels live in the admin panel
 *  but long enough that a steady stream of Baileys events coalesces into one
 *  round-trip. The hard cap protects worker memory if the gateway goes down
 *  mid-sync, on overflow the oldest events are dropped silently and a single
 *  roll-up warn is emitted when the buffer drains back below the cap. We
 *  accept lossy backpressure over unbounded memory growth; `chat_events` is
 *  best-effort upstream. */
const HISTORY_BATCH_SIZE = 500;
const HISTORY_FLUSH_IDLE_MS = 250;
// why: 25K events × ~1–2KB each ≈ 25–50MB resident at peak during a fresh
// long-history pair. Headroom over the previous 5K cap so transient gateway
// slowdowns don't lose data; conservative enough to avoid memory pressure on
// the 8/16GB M1.
const HISTORY_BUFFER_HARD_CAP = 25_000;
const CONTACT_BATCH_SIZE = 500;
const CONTACT_BUFFER_HARD_CAP = 50_000;

export interface RuntimeEvents {
  onStatusChange: (status: 'pairing' | 'connected' | 'degraded' | 'offline') => void;
  onQr: (dataUrl: string) => void;
}

export class BaileysRuntime {
  private readonly logger: pino.Logger;
  private readonly redisSub: Redis;
  private readonly redisOps: Redis;
  private readonly gateway: GatewayClient;
  private sock: any | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private configRefreshTimer: NodeJS.Timeout | null = null;

  // ---- outbound-subscription health (half-open detector) ----
  /** True when the outbound subscription is believed live (connected AND a
   *  round-trip health probe has succeeded). Surfaced on the heartbeat so the
   *  gateway can distinguish "worker process up" from "worker actually
   *  listening for sends". */
  private outboundSubscribed = false;
  /** Periodic round-trip probe timer; cleared in `stop()`. */
  private healthProbeTimer: NodeJS.Timeout | null = null;
  /** Nonce of the in-flight probe we're waiting to receive back, or null. */
  private pendingHealthNonce: string | null = null;
  /** Resolver for the in-flight probe round-trip; called by `on('message')`
   *  when the matching nonce arrives on the private health channel. */
  private healthEchoResolve: (() => void) | null = null;
  /** True after a probe has missed once, a second consecutive miss escalates
   *  to `process.exit(1)` so launchd restarts the worker (a fresh start
   *  re-subscribes AND drains pending). */
  private healthProbeMissed = false;
  private status: 'offline' | 'pairing' | 'connected' | 'degraded' = 'offline';
  private phoneE164: string | null = null;
  private stopping = false;
  private currentQr: string | null = null;
  /** Read-receipt toggle fetched from gateway; defaults to true (on failure too). */
  private sendReadReceipts = true;
  /** Baileys history-sync toggle fetched from gateway per session. Default
   *  false because (a) outbound-only sessions don't need chat archive and
   *  (b) full history sync is the load-bearing fragility behind reboot-
   *  forces-rescan incidents (see PR #71). Set to true via the per-session
   *  conversation config when an inbound/triage session truly needs it. */
  private syncFullHistory = false;

  // ---- history-sync state (PR-2) ----
  /** Pending `chat_event_batch` items awaiting flush. */
  private historyBuffer: HistoryEventItem[] = [];
  /** Pending `contact_batch` items keyed by `jid`, last write wins so a
   *  contact updated via `contacts.set` after `messaging-history.set` doesn't
   *  enqueue twice. Iterated as `values()` when building the wire batch. */
  private contactBuffer: Map<string, ContactItem> = new Map();
  /** Idle-window timer; cleared on each enqueue and on flush. */
  private historyFlushTimer: NodeJS.Timeout | null = null;
  /** Running total of history events received in the current sync run. */
  private historyReceived = 0;
  /** Whether Baileys has signalled the final batch (`isLatest === true`). */
  private historyLatestSeen = false;
  /** True while at least one batch has been flushed in this sync run. */
  private historySyncActive = false;
  /** True for one heartbeat after the final flush, to clear the badge. */
  private historySyncJustCompleted = false;
  /** Set once per run when the `isLatest: true` batch has been emitted, so a
   *  re-entrant flush cannot send a second `isLatest: true` envelope. */
  private historyFinalEmitted = false;
  /** Re-entrancy guards for `flushHistory`. While `isFlushing` is true, any
   *  nested call sets `flushPending` and the in-flight flush re-enters via
   *  `queueMicrotask` once it returns. Prevents two concurrent drains
   *  computing `finalForRun` against stale buffer state. */
  private isFlushing = false;
  private flushPending = false;
  /** Overflow state for the history buffer. Warn fires once on the
   *  `false → true` transition; while saturated, drops are counted silently
   *  and rolled up into a single warn when the buffer drains below the cap. */
  private historyOverflowState = false;
  private historyDroppedSinceOverflowStart = 0;
  /** Same overflow pattern for the contact buffer. */
  private contactOverflowState = false;
  private contactDroppedSinceOverflowStart = 0;

  /** Per-run monotonic batch index for `chat_event_batch` envelopes during
   *  history sync. Incremented after each batch is dispatched (success or
   *  buffer-restore on failure) so slice 4 can correlate batches in order. */
  private historyBatchIndex = 0;
  /** Encryption key for the per-session secret store, captured during
   *  `bootBaileys` so `flushHistory` can persist `firstPairCompletedAt`
   *  without re-loading the keychain entry. */
  private encKey: Buffer | null = null;
  /** waMessageIds we've already emitted a `message_revision` (kind=edit) for
   *  in this process. Both `messages.update` and the own-device-edit branch in
   *  `messages.upsert` can fire for the same edit; this set dedupes. Entries
   *  self-evict after 5 minutes. */
  private recentlyEmittedEditIds = new Set<string>();
  private static readonly EDIT_DEDUP_TTL_MS = 5 * 60_000;

  /** waMessageIds the gateway just sent. Baileys echoes every send back via
   *  `messages.upsert` with `fromMe: true`; without this guard the worker
   *  would emit an `out_device` chat_event that duplicates the canonical
   *  `messages` row, surfacing as a ghost "[Attachment]" row in the admin
   *  thread when the chat has disappearing-messages or view-once enabled
   *  (the wrappers defeat content extraction). Entries self-evict after the
   *  echo arrives or after a 5-minute fallback. */
  private ownSentIds = new Set<string>();
  private static readonly OWN_SENT_TTL_MS = 5 * 60_000;

  /** Content of messages we sent, keyed by waMessageId, for Baileys'
   *  `getMessage`. When a recipient's device fails to decrypt, WhatsApp asks
   *  the sender to re-send that exact message; with no store to answer from,
   *  Baileys cannot satisfy the retry and the message silently never lands.
   *  Bounded rather than TTL'd, a retry that arrives after 500 further sends
   *  is not worth holding every message in memory for. */
  private readonly sentMessages = new BoundedCache(500);
  /** Retry counters Baileys maintains per message; it only needs somewhere
   *  durable-ish to put them. */
  private readonly msgRetryCounterCache = new BoundedCache(1_000);
  /** Group metadata served to Baileys on every group send. Without it Baileys
   *  re-fetches the roster per message, which is both slow and a documented
   *  way to get rate-limited. Kept fresh by the `groups.update` and
   *  `group-participants.update` handlers below. */
  private readonly groupMetadataCache = new BoundedCache(200);

  /** Auto-recovery: did Baileys ever reach `connection === 'open'` since the
   *  current bootBaileys() invocation? Used to detect the "session invalidated"
   *  pattern, when the WhatsApp server has rotated session keys server-side
   *  while we were offline, the Noise handshake completes but the first
   *  encrypted frame fails. Baileys raises `Stream Errored (restart required)`
   *  or `Connection Failure` and emits a `close` event before ever reaching
   *  `open`. If we keep retrying the same on-disk creds we loop forever.
   *  Once `connection === 'open'` fires, we know the session is good and
   *  reset this back to true so transient post-connect drops trigger normal
   *  retry instead of session reset. */
  private hasReachedOpenSinceBoot = false;
  /** Auto-recovery: consecutive disconnect attempts without ever reaching
   *  `open` since the current boot. Crosses the threshold → trigger
   *  autoResetSession to back up the corrupted state and force a fresh QR. */
  private startupCloseCount = 0;
  /** Auto-recovery: how many close-without-open events to tolerate before
   *  declaring the session invalidated. Two attempts ≈ 6 seconds at the
   *  current 3-second retry cadence. */
  private static readonly STARTUP_CLOSE_THRESHOLD = 2;
  /** Auto-recovery: ensure autoResetSession runs at most once per boot, so
   *  we can't accidentally loop into "reset → retry → reset" if WA is
   *  unhappy for some other reason. */
  private autoResetInFlight = false;

  constructor(
    private readonly cfg: WorkerConfig,
    private readonly sessionId: string,
    private readonly wireSecret: Buffer,
    private readonly events: RuntimeEvents,
    private readonly onTokenRotate: (tok: string) => void,
    /** Shared token holder owned by SessionManager so every client rotates in
     *  lockstep. Optional so a standalone runtime still works in isolation. */
    private readonly tokenStore?: TokenStore,
  ) {
    this.logger = pino({ level: cfg.logLevel, base: { app: 'hmd-wa-worker', sessionId } });
    this.redisSub = new Redis(cfg.upstashRedisUrl, REDIS_OPTS);
    this.redisOps = new Redis(cfg.upstashRedisUrl, REDIS_OPTS);
    this.wireConnectionHandlers();
    this.gateway = new GatewayClient({
      baseUrl: cfg.gatewayBaseUrl,
      refreshToken: cfg.refreshToken,
      tokenStore,
      wireSecret,
      onTokenRotate,
    });
  }

  get currentStatus() {
    return this.status;
  }
  get pairedPhone() {
    return this.phoneE164;
  }
  get latestQr() {
    return this.currentQr;
  }

  /**
   * Attach loud lifecycle handlers to both long-lived Redis connections. ioredis
   * auto-resubscribes on reconnect, but we re-issue our subscriptions explicitly
   * on `'ready'` (idempotent) so a half-open socket that ioredis tore down and
   * rebuilt without our knowledge still ends up listening on the right channels.
   * Wired in the constructor so events during the initial `connect()` aren't lost.
   */
  private wireConnectionHandlers(): void {
    const attach = (conn: Redis, name: 'redisSub' | 'redisOps') => {
      conn.on('error', (err: Error) =>
        this.logger.error(
          { sessionId: this.sessionId, conn: name, err: err.message },
          'redis connection error',
        ),
      );
      conn.on('close', () => {
        this.logger.warn({ sessionId: this.sessionId, conn: name }, 'redis connection closed');
        if (name === 'redisSub') this.outboundSubscribed = false;
      });
      conn.on('end', () => {
        this.logger.warn({ sessionId: this.sessionId, conn: name }, 'redis connection ended');
        if (name === 'redisSub') this.outboundSubscribed = false;
      });
      conn.on('reconnecting', () =>
        this.logger.warn({ sessionId: this.sessionId, conn: name }, 'redis reconnecting'),
      );
      conn.on('ready', () => {
        this.logger.info({ sessionId: this.sessionId, conn: name }, 'redis connection ready');
        if (name === 'redisSub' && !this.stopping) {
          // Re-issue our subscriptions after any (re)connect. Idempotent.
          this.subscribeOutbound().catch((err) =>
            this.logger.error(
              { sessionId: this.sessionId, err: (err as Error).message },
              're-subscribe on ready failed',
            ),
          );
        }
      });
    };
    attach(this.redisSub, 'redisSub');
    attach(this.redisOps, 'redisOps');
  }

  /**
   * Subscribe `redisSub` to the outbound send channel and the private health
   * channel. Idempotent, safe to call again after a reconnect even though
   * ioredis auto-resubscribes. Sets `outboundSubscribed` on success.
   */
  private async subscribeOutbound(): Promise<void> {
    await this.redisSub.subscribe(`wa:outbound:${this.sessionId}`);
    await this.redisSub.subscribe(HEALTH_CHANNEL(this.sessionId));
    this.outboundSubscribed = true;
  }

  /**
   * Half-open detector. The HTTP heartbeat travels a different path than the
   * Redis subscribe, so a heartbeat can keep reporting `connected` while the
   * SUBSCRIBE has silently died server-side (Upstash drop, ioredis misses it).
   * This probe exercises the actual work path: publish a fresh nonce via
   * `redisOps` to the private health channel and wait to receive it back on
   * `redisSub`. A missed round-trip forces one reconnect+resubscribe; a second
   * consecutive miss exits the process so launchd restarts (a fresh start
   * re-subscribes AND drains pending, the desired self-heal).
   */
  private startHealthProbe(): void {
    this.healthProbeTimer = setInterval(() => {
      this.runHealthProbe().catch((err) =>
        this.logger.error(
          { sessionId: this.sessionId, err: (err as Error).message },
          'health probe threw',
        ),
      );
    }, HEALTH_PROBE_INTERVAL_MS);
    this.healthProbeTimer.unref?.();
  }

  private async runHealthProbe(): Promise<void> {
    const nonce = randomUUID();
    this.pendingHealthNonce = nonce;
    const echoed = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.healthEchoResolve = null;
        resolve(false);
      }, HEALTH_PROBE_TIMEOUT_MS);
      this.healthEchoResolve = () => {
        clearTimeout(timer);
        resolve(true);
      };
      this.redisOps.publish(HEALTH_CHANNEL(this.sessionId), nonce).catch((err: Error) => {
        this.logger.error(
          { sessionId: this.sessionId, err: err.message },
          'health probe publish failed',
        );
      });
    });
    this.pendingHealthNonce = null;

    if (echoed) {
      this.outboundSubscribed = true;
      this.healthProbeMissed = false;
      return;
    }

    this.outboundSubscribed = false;
    this.logger.error(
      { sessionId: this.sessionId },
      'outbound subscription half-open, health probe round-trip missed',
    );

    if (this.healthProbeMissed) {
      // Second consecutive miss after a forced reconnect already failed, // exit so launchd restarts the worker (re-subscribe + drain pending).
      this.logger.error(
        { sessionId: this.sessionId },
        'health probe missed twice, exiting for launchd restart',
      );
      process.exit(1);
    }

    this.healthProbeMissed = true;
    this.logger.warn(
      { sessionId: this.sessionId },
      'forcing redisSub reconnect + resubscribe after missed probe',
    );
    try {
      this.redisSub.disconnect();
      await this.redisSub.connect();
      await this.subscribeOutbound();
    } catch (err) {
      this.logger.error(
        { sessionId: this.sessionId, err: (err as Error).message },
        'forced reconnect after missed probe failed, next miss will exit',
      );
    }
  }

  /** Resolve the in-flight probe when its nonce echoes back on the health channel. */
  private onHealthEcho(message: string): void {
    if (this.pendingHealthNonce && message === this.pendingHealthNonce && this.healthEchoResolve) {
      const resolve = this.healthEchoResolve;
      this.healthEchoResolve = null;
      resolve();
    }
  }

  async start(): Promise<void> {
    await Promise.all([this.redisSub.connect(), this.redisOps.connect()]);
    await this.subscribeOutbound();
    this.redisSub.on('message', (channel, message) => {
      // The private health channel carries round-trip nonces for the half-open
      // detector, not send envelopes, resolve the pending probe and stop.
      if (channel === HEALTH_CHANNEL(this.sessionId)) {
        this.onHealthEcho(message);
        return;
      }
      this.handleIncomingWire(channel, message).catch((err) =>
        this.logger.error({ err: err.message }, 'handleIncomingWire failed'),
      );
    });

    // Drain any pending messages from before the worker was up.
    this.drainPending().catch((err) =>
      this.logger.warn({ err: err.message }, 'drainPending failed'),
    );

    // Initial conversational-config fetch, best-effort; default already true.
    try {
      const c = await this.gateway.getSessionConfig(this.sessionId);
      this.sendReadReceipts = c.sendReadReceipts;
      this.syncFullHistory = c.syncFullHistory;
      this.logger.info(
        { sendReadReceipts: this.sendReadReceipts, syncFullHistory: this.syncFullHistory },
        'session config loaded',
      );
    } catch (err) {
      this.logger.warn(
        { err: (err as Error).message },
        'getSessionConfig failed on start, defaulting sendReadReceipts=true',
      );
    }

    await this.bootBaileys();
    this.startHeartbeat();
    this.startConfigRefresh();
    this.startHealthProbe();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.configRefreshTimer) clearInterval(this.configRefreshTimer);
    if (this.healthProbeTimer) clearInterval(this.healthProbeTimer);
    if (this.historyFlushTimer) clearTimeout(this.historyFlushTimer);
    this.outboundSubscribed = false;

    // Signal offline up front (awaited, bounded) so the gateway flips this
    // session's status immediately and the send-path picker fails over to a
    // pool peer at once, instead of waiting ~35s for the heartbeat to age out.
    try {
      await Promise.race([
        this.gateway.callback({
          kind: 'heartbeat',
          workerId: this.cfg.workerId,
          sessionId: this.sessionId,
          status: 'offline',
          phoneE164: this.phoneE164,
          version: process.env.npm_package_version ?? 'dev',
          subscribed: false,
        }),
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ]);
    } catch {
      /* best-effort; never block shutdown on a slow gateway */
    }

    // Close the socket WITHOUT logging out. sock.logout() de-registers the
    // WhatsApp linked device, forcing a QR re-pair on every graceful restart;
    // sock.end() just drops the connection so the next boot reconnects the
    // existing auth-state. This is what makes worker deploys non-destructive.
    try {
      this.sock?.end?.(undefined);
    } catch {
      /* ignore */
    }
    this.redisSub.disconnect();
    this.redisOps.disconnect();
  }

  private setStatus(s: typeof this.status) {
    this.status = s;
    this.events.onStatusChange(s);
    this.gateway
      .callback({
        kind: 'heartbeat',
        workerId: this.cfg.workerId,
        sessionId: this.sessionId,
        status: s,
        phoneE164: this.phoneE164,
        version: process.env.npm_package_version ?? 'dev',
        subscribed: this.outboundSubscribed,
      })
      .catch((err) => this.logger.warn({ err: err.message }, 'status callback failed'));
  }

  private async bootBaileys(): Promise<void> {
    // Reset auto-recovery tracking for this boot. The connection.update
    // handler flips hasReachedOpenSinceBoot=true on the first successful
    // 'open' event; until then close events are counted against the
    // session-invalidated threshold.
    this.hasReachedOpenSinceBoot = false;
    this.startupCloseCount = 0;
    const keychainKey = loadOrCreateKey(this.sessionId);
    this.encKey = keychainKey;
    const { state, saveCreds } = await useEncryptedAuthState(keychainKey, this.sessionId);
    const { version } = await fetchLatestBaileysVersion();

    this.sock = makeWASocket({
      version,
      logger: this.logger.child({ sub: 'baileys' }) as any,
      printQRInTerminal: false,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, this.logger as any),
      },
      browser: ['HMD WA Gateway', 'Safari', '1.0'],
      // Per-session history-sync toggle. The runtime field is hydrated from
      // the gateway's conversation config (SessionDoc.conversation.syncFullHistory)
      // before bootBaileys runs. Defaults to false because (a) the canonical
      // example-service session is outbound-only and (b) full history sync is
      // the load-bearing fragility behind reboot-forces-rescan incidents (see
      // PR #71, #74). Set true only for sessions that genuinely need the chat
      // archive, accept the reboot trade-off explicitly.
      syncFullHistory: this.syncFullHistory,
      markOnlineOnConnect: false,
      // Answer WhatsApp's "please re-send that message" retries. Without this
      // Baileys has nothing to re-encrypt and the send is silently lost for
      // the recipient whose device failed to decrypt it.
      getMessage: async (key) =>
        (key.id ? this.sentMessages.get<proto.IMessage>(key.id) : undefined) ?? undefined,
      msgRetryCounterCache: this.msgRetryCounterCache,
      // Serve group metadata from cache instead of re-fetching the roster on
      // every group send, the documented cause of group-send rate limiting.
      cachedGroupMetadata: async (jid) => this.groupMetadataCache.get<GroupMetadata>(jid),
    });

    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('connection.update', async (u: any) => {
      const { connection, lastDisconnect, qr } = u;
      if (qr) {
        const dataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 256 });
        this.currentQr = dataUrl;
        this.setStatus('pairing');
        this.events.onQr(dataUrl);
        this.gateway
          .callback({
            kind: 'pairing',
            workerId: this.cfg.workerId,
            sessionId: this.sessionId,
            event: 'qr',
            qr: dataUrl,
          })
          .catch((err) => this.logger.warn({ err: err.message }, 'pairing callback failed'));
      }
      if (connection === 'open') {
        this.phoneE164 = this.sock?.user?.id?.split(':')[0] ?? null;
        this.currentQr = null;
        this.hasReachedOpenSinceBoot = true;
        this.startupCloseCount = 0;
        this.setStatus('connected');
        this.gateway
          .callback({
            kind: 'pairing',
            workerId: this.cfg.workerId,
            sessionId: this.sessionId,
            event: 'paired',
          })
          .catch(() => {});
        // Auxiliary, best-effort: seed the gateway's `groups` collection with
        // the full participating set on every fresh connection (initial pair
        // AND every reconnect). Fire-and-forget, a fetch or push failure
        // here must never block message handling, and this runs once per
        // 'open', not on a timer, so it can't become the kind of idle-chatter
        // storm that caused the 2026-07-08 Upstash quota outage.
        this.fetchAndPushAllGroupMetadata().catch((err) =>
          this.logger.warn(
            { err: (err as Error).message },
            'initial group metadata fetch failed (non-fatal)',
          ),
        );
      }
      if (connection === 'close') {
        const reason = (lastDisconnect?.error as any)?.output?.statusCode;
        const loggedOut = reason === DisconnectReason.loggedOut;
        // Auto-recovery: detect the "session invalidated by WhatsApp" pattern.
        // Triggers on any of:
        //   - Explicit logout (DisconnectReason.loggedOut)
        //   - badSession / connectionReplaced / multideviceMismatch
        //   - Repeated close events without ever reaching 'open' since boot
        //     (signals "Stream Errored / decodeFrame on first encrypted frame"
        //     where Baileys' own creds-from-disk no longer match WA's view)
        const sessionInvalidReasons = new Set<number | undefined>([
          DisconnectReason.loggedOut,
          DisconnectReason.badSession,
          DisconnectReason.connectionReplaced,
          DisconnectReason.multideviceMismatch,
        ]);
        const isExplicitFatal = sessionInvalidReasons.has(reason);
        if (!this.hasReachedOpenSinceBoot) this.startupCloseCount += 1;
        const exceededStartupThreshold =
          !this.hasReachedOpenSinceBoot &&
          this.startupCloseCount >= BaileysRuntime.STARTUP_CLOSE_THRESHOLD;
        const shouldAutoReset =
          !this.stopping &&
          !this.autoResetInFlight &&
          (isExplicitFatal || exceededStartupThreshold);
        if (loggedOut) {
          this.setStatus('offline');
          this.gateway
            .callback({
              kind: 'pairing',
              workerId: this.cfg.workerId,
              sessionId: this.sessionId,
              event: 'logged_out',
            })
            .catch(() => {});
        }
        if (shouldAutoReset) {
          this.autoResetInFlight = true;
          this.logger.warn(
            {
              reason,
              isExplicitFatal,
              startupCloseCount: this.startupCloseCount,
              hasReachedOpenSinceBoot: this.hasReachedOpenSinceBoot,
            },
            'session appears invalidated, auto-resetting (will emit fresh QR)',
          );
          this.autoResetSession().catch((err) =>
            this.logger.error({ err: (err as Error).message }, 'autoResetSession failed'),
          );
        } else if (!loggedOut && !this.stopping) {
          this.setStatus('degraded');
          setTimeout(() => this.bootBaileys().catch(() => {}), 3_000);
        }
      }
    });

    this.sock.ev.on('messages.upsert', async ({ messages }: { messages: any[] }) => {
      for (const m of messages) {
        // why: the chat_events unique index is (sessionId, waMessageId); a
        // missing m.key.id would collide on a sentinel value and silently
        // drop every subsequent un-id'd message. Same risk on inbound dedup.
        const waMessageId: string | undefined = m.key?.id ?? undefined;
        const rawRemoteJid: string | undefined = m.key?.remoteJid ?? undefined;
        if (!waMessageId || !rawRemoteJid) {
          this.logger.warn(
            { hasId: Boolean(waMessageId), hasJid: Boolean(rawRemoteJid) },
            'messages.upsert skipped, missing key.id or key.remoteJid',
          );
          continue;
        }
        // why: Baileys v7 surfaces senders by their LID alias for accounts
        // that have migrated to the LID address book. The rest of the
        // pipeline (gateway lookups, jidToE164) assumes `@s.whatsapp.net`,
        // so translate at the ingress boundary. Groups (`@g.us`) and PN
        // JIDs pass through unchanged.
        const remoteJid = await resolveJid(this.sock, rawRemoteJid, this.logger);
        const isGroup = remoteJid.endsWith('@g.us');
        const fromMe = Boolean(m.key.fromMe);

        // Case E, protocolMessage wrappers carry edits and revokes from the
        // peer or another linked device. Baileys also surfaces revokes via
        // `messages.update` (process-message.js re-emits them); the edit path
        // is upsert-only because there's no upstream `messages.update` for
        // edits in Baileys (confirmed on 6.7.8 and v7.0.0-rc10). We dedupe
        // across both paths via
        // `recentlyEmittedEditIds`.
        const protocolMsg = m.message?.protocolMessage as
          | { type?: number; key?: { id?: string }; editedMessage?: any }
          | undefined;
        if (protocolMsg) {
          const t = protocolMsg.type;
          const targetWaMessageId = protocolMsg.key?.id;
          if (t === proto.Message.ProtocolMessage.Type.MESSAGE_EDIT && targetWaMessageId) {
            if (!this.recentlyEmittedEditIds.has(targetWaMessageId)) {
              this.rememberEmittedEdit(targetWaMessageId);
              this.emitMessageRevisionEdit({
                waMessageId: targetWaMessageId,
                editedMessage: protocolMsg.editedMessage,
                ts: baileysTimestampToIso(m.messageTimestamp),
              });
            }
            // why: the wrapper itself isn't a viewer-relevant chat_event, // the original message it edits already exists. Skip Case A/B/C.
            continue;
          }
          if (t === proto.Message.ProtocolMessage.Type.REVOKE && targetWaMessageId) {
            this.emitMessageRevisionDelete({
              waMessageId: targetWaMessageId,
              fromMe,
              ts: baileysTimestampToIso(m.messageTimestamp),
            });
            continue;
          }
        }

        // Case A, outbound from this account on the paired phone or another
        // linked device. Capture as a chat_event so the admin viewer can show
        // it; the existing send_ack path does not cover device-side outbound.
        if (fromMe) {
          // Skip echoes of gateway-originated sends, `messages` already holds
          // the canonical row. Without this, ephemeral/view-once wrappers on
          // the echo cause `extractChatEventContent` to fall through to
          // `'other'`, surfacing as a duplicate "[Attachment]" in the UI.
          if (this.ownSentIds.has(waMessageId)) {
            this.ownSentIds.delete(waMessageId);
            continue;
          }
          this.emitChatEvent(m, {
            waMessageId,
            direction: 'out_device',
            counterpartyJid: remoteJid,
            counterpartyE164: jidToE164(remoteJid),
          });
          continue;
        }

        // Case B, inbound group message. The legacy inbound callback path
        // converts JIDs to E.164 and would silently drop groups; capture them
        // here instead. counterpartyE164 is null by definition for groups.
        if (isGroup) {
          this.emitChatEvent(m, {
            waMessageId,
            direction: 'in',
            counterpartyJid: remoteJid,
            counterpartyE164: null,
          });
          continue;
        }

        // Case C, inbound DM. Unchanged: existing inbound callback owns
        // persistence (`inbound_messages`) and webhook fan-out. Do NOT also
        // emit a chat_event for this, the viewer reads inbound DMs from
        // `inbound_messages`.
        const text = m.message?.conversation ?? m.message?.extendedTextMessage?.text ?? undefined;
        this.gateway
          .callback({
            kind: 'inbound',
            workerId: this.cfg.workerId,
            sessionId: this.sessionId,
            waMessageId,
            from: remoteJid,
            body: { kind: text ? 'text' : 'other', text },
          })
          .catch((err) => this.logger.warn({ err: err.message }, 'inbound callback failed'));

        // Conditionally mark this message as read so the peer sees blue ticks.
        // The toggle is fetched at start and refreshed every 30s, when it
        // flips off, the worker still receives messages but won't ack reads.
        if (this.sendReadReceipts) {
          this.sock
            ?.readMessages?.([m.key])
            .catch((err: Error) =>
              this.logger.warn({ err: err.message, waMessageId: m.key.id }, 'readMessages failed'),
            );
        }
      }
    });

    this.sock.ev.on('messages.update', async (updates: any[]) => {
      for (const u of updates) {
        // messages.update is keyed by the WhatsApp message id, not the gateway's
        // minted UUID, so report it as waMessageId (+ sessionId) and let the
        // gateway resolve the message via findByWaMessageId. Sending it as
        // `messageId` was the bug that left delivered/read receipts dead.
        const waMessageId = u.key.id as string | undefined;
        if (waMessageId) {
          const statusName =
            u.update.status === 2
              ? 'sent'
              : u.update.status === 3
                ? 'delivered'
                : u.update.status === 4
                  ? 'read'
                  : null;
          if (statusName) {
            this.gateway
              .callback({
                kind: 'receipt',
                workerId: this.cfg.workerId,
                sessionId: this.sessionId,
                waMessageId,
                status: statusName,
              })
              .catch(() => {});
          }
        }

        // Revoke (delete), surfaces here via `process-message.js` re-emit.
        // The deleted message id is `u.key.id` (the original, not the
        // protocol wrapper's id, because process-message remaps before
        // re-emitting). `update.message` is `null` in this case.
        if (u.update?.messageStubType === WAMessageStubType.REVOKE) {
          const waMessageId = u.key?.id as string | undefined;
          if (!waMessageId) continue;
          this.emitMessageRevisionDelete({
            waMessageId,
            fromMe: Boolean(u.key?.fromMe),
            ts: new Date().toISOString(),
          });
        }
      }
    });

    // Pre-pair history sync, Baileys replays the chat archive once per
    // pair via `messaging-history.set`. Each batch carries `messages` (the
    // historical WAMessages), `contacts`, `chats`, and an `isLatest` flag
    // that flips true on the final batch. We piggyback contacts onto the
    // same flush path via a `contact_batch` envelope (separate `kind`,
    // same endpoint and auth) so the schemas stay tight.
    //
    // why: events emitted from this handler MUST NOT trigger webhook
    // fan-out, opt-out detection, auto-reads, or admin notifications. The
    // batch endpoint's per-handler `// why:` and `dispatchEvent`'s guard
    // both enforce this; the worker side does not call any webhook
    // pathway directly.
    //
    // TODO(history-sync-v2): wire `chats.set` for chat-list bootstrap.
    this.sock.ev.on('messaging-history.set', async (payload: any) => {
      // why: gate on `firstPairCompletedAt`. Set means we've already done a
      // successful history backfill for this session; subsequent reconnects
      // (Baileys still emits `messaging-history.set` on some restarts with a
      // small delta) MUST NOT re-process the archive. Live tail keeps running
      // independently via `messages.upsert`.
      if (this.encKey && getFirstPairCompletedAt(this.encKey, this.sessionId)) {
        return;
      }

      const messages = (payload?.messages ?? []) as any[];
      const contacts = (payload?.contacts ?? []) as any[];
      const isLatest = Boolean(payload?.isLatest);

      // why: a non-loggedOut close re-runs `bootBaileys` which subscribes a
      // fresh listener for `messaging-history.set`. If the previous run had
      // already set `historyLatestSeen=true`, the badge would flip straight to
      // "Sync complete" before any of the new run's events arrive. Reset
      // sync-run state at the start of any subsequent run.
      if (this.historyLatestSeen) {
        this.resetHistorySyncState();
      }

      for (const m of messages) {
        const waMessageId: string | undefined = m?.key?.id ?? undefined;
        const rawRemoteJid: string | undefined = m?.key?.remoteJid ?? undefined;
        if (!waMessageId || !rawRemoteJid) {
          // why: same guard as the live path (`messages.upsert`), a sentinel
          // id would collide on the unique index and silently drop subsequent
          // un-id'd messages. Logged once at warn, not per-event.
          this.logger.warn(
            { hasId: Boolean(waMessageId), hasJid: Boolean(rawRemoteJid) },
            'history msg skipped, missing key.id or key.remoteJid',
          );
          continue;
        }
        // why: history-sync rows may carry `@lid` JIDs for which the
        // mapping store hasn't yet been populated (history precedes any
        // live decrypt). resolveJid soft-fails to the original JID in that
        // case, the event is still emitted but counterpartyE164 stays
        // null, matching the pre-v7 behaviour for un-resolvable JIDs.
        const remoteJid = await resolveJid(this.sock, rawRemoteJid, this.logger);
        const fromMe = Boolean(m.key.fromMe);
        const direction: 'in_history' | 'out_history' = fromMe ? 'out_history' : 'in_history';
        const counterpartyE164 = jidToE164(remoteJid);
        const ts = baileysTimestampToIso(m.messageTimestamp);
        // History-sync flow constructs `content` with `media.unavailable=true`
        // up front so callers don't have to mutate the value afterwards.
        const content = extractChatEventContent(m, { historySync: true });
        this.enqueueHistoryEvent({
          waMessageId,
          direction,
          source: 'history_sync',
          counterpartyJid: remoteJid,
          counterpartyE164,
          content,
          ts,
        });
      }

      for (const c of contacts) {
        const jid: string | undefined = c?.id ?? undefined;
        if (!jid) continue;
        this.enqueueContact(c, jid);
      }

      if (isLatest) {
        this.historyLatestSeen = true;
      }
      this.scheduleHistoryFlush(isLatest);
    });

    // Contact updates outside of `messaging-history.set` (Baileys emits
    // `contacts.set` and `contacts.update` separately on initial sync). We
    // route both into the same `contact_batch` flush. No webhook fan-out.
    this.sock.ev.on('contacts.set', ({ contacts }: { contacts: any[] }) => {
      for (const c of contacts ?? []) {
        const jid: string | undefined = c?.id ?? undefined;
        if (!jid) continue;
        this.enqueueContact(c, jid);
      }
      this.scheduleHistoryFlush(false);
    });

    // Per-contact upsert/update events, slice 1 `ContactEvent` shape, posted
    // to `/v1/worker/callback` as `kind: 'contact'`. These are distinct from
    // the legacy `chat_contacts` rows the existing `contact_batch` envelope
    // carries; the new `contacts` doc is keyed `(sessionId, e164)` and is a
    // replace-on-conflict snapshot. Singles, not batched: contacts.upsert
    // does fire in bursts during initial sync but each row is small and the
    // gateway-side `kind: 'contact'` branch lands in slice 4, singles keep
    // the wire shape simple until then.
    //
    // why: the gateway will 400 on `kind: 'contact'` until slice 4 wires the
    // route branch. That's the documented integration gap; the worker emits
    // are correct on the wire so the gap closes when slice 4 lands.
    this.sock.ev.on('contacts.upsert', async (contacts: any[]) => {
      for (const c of contacts ?? []) {
        this.emitContactEvent(c);
      }
    });
    this.sock.ev.on('contacts.update', async (updates: any[]) => {
      for (const c of updates ?? []) {
        this.emitContactEvent(c);
      }
    });

    // Group metadata refresh, auxiliary, best-effort. `groups.upsert` fires
    // for newly-joined/created groups and already carries full metadata;
    // `groups.update` fires on subject/description/settings changes but is
    // `Partial<GroupMetadata>` (may be missing fields we need), so we treat
    // it as a signal to re-fetch rather than trusting the partial payload.
    // Every push is a single `group_metadata` event, the bulk case is the
    // 'open'-triggered batch above, not these.
    this.sock.ev.on('groups.upsert', (groups: any[]) => {
      for (const g of groups ?? []) {
        if (!g?.id) continue;
        this.groupMetadataCache.set(g.id, g);
        this.emitGroupMetadata(g);
      }
    });
    this.sock.ev.on('groups.update', async (updates: any[]) => {
      for (const u of updates ?? []) {
        if (!u?.id) continue;
        await this.refetchAndEmitGroupMetadata(u.id);
      }
    });
    // Participant add/remove/promote/demote, the event payload only carries
    // the affected participants, not the full roster or an updated `size`.
    // Re-fetch the single group's metadata rather than trusting the partial
    // payload, per the plan's explicit instruction.
    this.sock.ev.on('group-participants.update', async (ev: any) => {
      if (!ev?.id) return;
      await this.refetchAndEmitGroupMetadata(ev.id);
    });

    // Inbound reactions, peer reacted to a message (theirs or ours).
    // Baileys emits the `reaction.key` as the key of the message that was
    // reacted to; `r.key` is the wrapper-message key (the reaction message
    // itself, which carries the sender JID).
    this.sock.ev.on('messages.reaction', async (reactions: any[]) => {
      for (const r of reactions) {
        const targetKey = r.reaction?.key ?? r.key;
        const rawFromJid = r.key?.remoteJid ?? targetKey?.remoteJid;
        if (!rawFromJid || !targetKey?.id) continue;
        // why: same v7 LID translation rationale as messages.upsert, the
        // reactor's JID may surface as `@lid` and would otherwise fail
        // jidToE164 below.
        const fromJid = await resolveJid(this.sock, rawFromJid, this.logger);
        const fromE164 = jidToE164(fromJid);
        if (!fromE164) continue; // groups, unresolved LIDs, other jid kinds are skipped for now
        this.gateway
          .callback({
            kind: 'reaction',
            workerId: this.cfg.workerId,
            sessionId: this.sessionId,
            targetWaMessageId: targetKey.id,
            targetFromMe: Boolean(targetKey.fromMe),
            from: fromE164,
            fromJid,
            emoji: r.reaction?.text ?? '',
          })
          .catch((err) => this.logger.warn({ err: err.message }, 'reaction callback failed'));
      }
    });
  }

  /**
   * Auto-recovery: move the on-disk session aside and restart Baileys so a
   * fresh pairing QR is generated. Called from the connection.update handler
   * when we detect WA has invalidated the session (Stream Errored on the
   * first encrypted frame after a clean Noise handshake, or an explicit
   * fatal DisconnectReason).
   *
   * The backup directory name is timestamped + suffixed `auto-reset` so it's
   * trivially distinguishable from manual re-pairs in the sessions folder.
   * Operator notification flows through the existing `pairing` event channel
   * (`event: 'qr'` callback emitted by the next bootBaileys), so admin UI
   * subscribers see the new QR appear automatically, no separate webhook
   * plumbing required.
   */
  private async autoResetSession(): Promise<void> {
    try {
      try {
        await this.sock?.ws?.close?.();
      } catch {
        /* ignore */
      }
      this.sock = null;
      const dir = sessionDir(this.sessionId);
      if (existsSync(dir)) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const backup = `${dir}.bak.${ts}-auto-reset`;
        renameSync(dir, backup);
        this.logger.warn({ backup }, 'session dir moved aside for auto-reset');
      }
      this.gateway
        .callback({
          kind: 'pairing',
          workerId: this.cfg.workerId,
          sessionId: this.sessionId,
          event: 'logged_out',
        })
        .catch(() => {});
      // Fire-and-forget operator notification. Configured via
      // HMD_WA_NOTIFY_WEBHOOK_URL env / notifyWebhookUrl in config.json.
      // Sent BEFORE bootBaileys so the operator gets pinged even if the
      // subsequent QR-generation fails for any reason.
      this.sendPairingNotification().catch((err) =>
        this.logger.warn(
          { err: (err as Error).message },
          'pairing notification webhook failed (non-fatal)',
        ),
      );
      this.setStatus('pairing');
      this.currentQr = null;
      await this.bootBaileys();
      this.logger.info('auto-reset complete, fresh QR will surface via pairing callback');
    } finally {
      this.autoResetInFlight = false;
    }
  }

  /**
   * POST to the configured notify webhook to alert the operator that a
   * WhatsApp re-pair is required (the QR will appear in the admin UI
   * within seconds; the operator just needs to know to look). Quiet
   * no-op if HMD_WA_NOTIFY_WEBHOOK_URL is unset.
   *
   * Body shape is intentionally generic, point the URL at a Telegram
   * bot's sendMessage endpoint, a Discord webhook, an n8n trigger,
   * Zapier, a custom service. The receiver maps `event` to whatever
   * notification format it produces. 5-second timeout so a dead
   * webhook can't stall the auto-reset flow.
   */
  private async sendPairingNotification(): Promise<void> {
    const url = this.cfg.notifyWebhookUrl;
    if (!url) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'pairing_required',
          sessionId: this.sessionId,
          workerId: this.cfg.workerId,
          gatewayBaseUrl: this.cfg.gatewayBaseUrl,
          ts: new Date().toISOString(),
        }),
        signal: controller.signal,
      });
      this.logger.info({ url }, 'pairing notification sent');
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Emit a `chat_event` callback for cases the legacy inbound / outbound
   * paths don't cover (device-side outbound, live group messages). Source is
   * always `'live'` here, the history-sync path is a separate follow-up.
   * Failures are logged and swallowed; this is a best-effort capture.
   */
  private emitChatEvent(
    m: any,
    args: {
      waMessageId: string;
      direction: 'in' | 'out_device';
      counterpartyJid: string;
      counterpartyE164: string | null;
    },
  ): void {
    const { waMessageId } = args;
    const ts = baileysTimestampToIso(m.messageTimestamp);
    const content = extractChatEventContent(m, { historySync: false });
    this.gateway
      .callback({
        kind: 'chat_event',
        workerId: this.cfg.workerId,
        sessionId: this.sessionId,
        waMessageId,
        direction: args.direction,
        source: 'live',
        counterpartyJid: args.counterpartyJid,
        counterpartyE164: args.counterpartyE164,
        content,
        ts,
      })
      .catch((err) =>
        this.logger.warn(
          { err: err.message, waMessageId, direction: args.direction },
          'chat_event callback failed',
        ),
      );
  }

  /**
   * Emit a `message_revision` event for an edit. The body is derived from the
   * `editedMessage` payload via the existing chat-event extractor mapped onto
   * the `MessageRevisionBody` shape (slice 1). Source is `'live'`, history
   * edits aren't in scope for this slice.
   *
   * Note: emits with `waMessageId`, NOT the gateway's UUID. The worker has no
   * reliable mapping from waMessageId → messageId (the messages collection is
   * gateway-side and the lookup would be racy on first capture). Slice 4 is
   * expected to retrofit `MessageRevisionEventSchema.messageId` to
   * `waMessageId` and resolve to the gateway UUID at insert time. Until then,
   * this field name doesn't match the schema, gateway will 400 until the
   * slice 4 retrofit lands.
   */
  private emitMessageRevisionEdit(args: {
    waMessageId: string;
    editedMessage: unknown;
    ts: string;
  }): void {
    const body = extractRevisionBody(args.editedMessage);
    this.gateway
      .callback({
        kind: 'message_revision',
        workerId: this.cfg.workerId,
        sessionId: this.sessionId,
        // why: emitting `waMessageId` instead of `messageId` (UUID). Slice 1
        // schema retrofit required, see slice 3 report.
        waMessageId: args.waMessageId,
        revisionKind: 'edit',
        body,
        ts: args.ts,
        source: 'live',
      })
      .catch((err: unknown) =>
        this.logger.warn(
          { err: (err as Error).message, waMessageId: args.waMessageId },
          'message_revision edit callback failed',
        ),
      );
  }

  /**
   * Emit a `message_revision` event for a delete (revoke). `deletedBy` derived
   * from `key.fromMe`, a revoke we authored is `'self'`, otherwise `'sender'`.
   * Admin-initiated deletes don't pass through Baileys, so they're not handled
   * here.
   */
  private emitMessageRevisionDelete(args: {
    waMessageId: string;
    fromMe: boolean;
    ts: string;
  }): void {
    this.gateway
      .callback({
        kind: 'message_revision',
        workerId: this.cfg.workerId,
        sessionId: this.sessionId,
        waMessageId: args.waMessageId,
        revisionKind: 'delete',
        deletedBy: args.fromMe ? 'self' : 'sender',
        ts: args.ts,
        source: 'live',
      })
      .catch((err: unknown) =>
        this.logger.warn(
          { err: (err as Error).message, waMessageId: args.waMessageId },
          'message_revision delete callback failed',
        ),
      );
  }

  /**
   * Emit a `contact` event for a single Baileys contact record. `e164` is
   * derived via `jidToE164`; if the JID isn't a `@s.whatsapp.net` user JID
   * (groups, broadcasts, status), we skip, the new `contacts` doc requires a
   * valid E.164.
   */
  private emitContactEvent(c: any): void {
    const jid: string | undefined = c?.id ?? undefined;
    if (!jid) return;
    const e164 = jidToE164(jid);
    if (!e164) return; // groups/broadcasts/status, not in the contact-book scope

    const displayName: string | undefined =
      (c.name as string | undefined) ??
      (c.verifiedName as string | undefined) ??
      (c.notify as string | undefined) ??
      undefined;
    const pushName: string | undefined =
      (c.notify as string | undefined) ?? (c.name as string | undefined) ?? undefined;
    // why: `c.imgUrl` is Baileys' nullable profile-pic URL on contact rows.
    // The slice-1 schema requires a valid URL; coerce empty/'changed' tokens
    // to undefined.
    const imgUrl =
      typeof c.imgUrl === 'string' && /^https?:\/\//.test(c.imgUrl) ? c.imgUrl : undefined;

    this.gateway
      .callback({
        kind: 'contact',
        workerId: this.cfg.workerId,
        sessionId: this.sessionId,
        e164,
        waJid: jid,
        displayName,
        pushName,
        profilePictureUrl: imgUrl,
        isBusiness: Boolean((c as { verifiedName?: string }).verifiedName),
        // Baileys exposes lastSeen on presence updates, not contact rows,
        // so it's not populated here. Slice-1 leaves the field optional.
        source:
          this.encKey && getFirstPairCompletedAt(this.encKey, this.sessionId) ? 'live' : 'history',
      })
      .catch((err: unknown) =>
        this.logger.warn({ err: (err as Error).message, e164 }, 'contact callback failed'),
      );
  }

  /**
   * Full-set group metadata refresh, run once per `connection === 'open'`
   * (initial pair and every reconnect, never on a timer). Fetches every
   * group the session participates in via `groupFetchAllParticipating()` and
   * pushes the whole set as a single `group_metadata_batch` envelope so a
   * large account (hundreds of groups) doesn't emit hundreds of individual
   * callbacks. Auxiliary and best-effort: any failure here is logged and
   * swallowed, it must never affect message handling or the connection
   * lifecycle.
   */
  private async fetchAndPushAllGroupMetadata(): Promise<void> {
    if (!this.sock) return;
    const all = await this.sock.groupFetchAllParticipating();
    const jids = Object.keys(all);
    if (jids.length === 0) return;
    // Seed the send-path cache from the same fetch. This runs on every
    // reconnect, so it is what keeps `cachedGroupMetadata` warm after a
    // restart rather than making the first group send pay a roster fetch.
    for (const jid of jids) this.groupMetadataCache.set(jid, all[jid]);
    const items = jids.map((jid) => ({ metadata: mapBaileysGroupMetadata(all[jid]) }));
    try {
      await this.gateway.batchCallback({
        kind: 'group_metadata_batch',
        workerId: this.cfg.workerId,
        sessionId: this.sessionId,
        items,
      });
      this.logger.info({ count: items.length }, 'group metadata batch pushed');
    } catch (err: unknown) {
      this.logger.warn(
        { err: (err as Error).message, count: items.length },
        'group_metadata_batch push failed (non-fatal, will retry on next reconnect)',
      );
    }
  }

  /**
   * Re-fetch a single group's full metadata and push it as one
   * `group_metadata` event. Used for `groups.update` (partial payload, may
   * be missing fields we need) and `group-participants.update` (payload only
   * carries the affected participants, not the full roster or an updated
   * `size`), per the plan's instruction to trust a fresh fetch over the
   * partial event body. Auxiliary and best-effort, logged and swallowed on
   * failure, never allowed to affect message handling.
   */
  private async refetchAndEmitGroupMetadata(jid: string): Promise<void> {
    if (!this.sock) return;
    try {
      const meta = await this.sock.groupMetadata(jid);
      // Refresh the cache Baileys reads on every group send, not just the
      // gateway's copy, a stale roster there is what triggers rate limiting.
      this.groupMetadataCache.set(jid, meta);
      this.emitGroupMetadata(meta);
    } catch (err: unknown) {
      this.logger.warn(
        { err: (err as Error).message, jid },
        'group metadata re-fetch failed (non-fatal)',
      );
    }
  }

  /**
   * Emit a single `group_metadata` event for one Baileys `GroupMetadata`
   * record. Push failures are logged with JID + participant count only, * never the subject, description, invite code, or participant JIDs
   * (member phone numbers), per the no-PII-in-logs baseline.
   */
  private emitGroupMetadata(raw: any): void {
    const metadata = mapBaileysGroupMetadata(raw);
    this.gateway
      .callback({
        kind: 'group_metadata',
        workerId: this.cfg.workerId,
        sessionId: this.sessionId,
        metadata,
      })
      .catch((err: unknown) =>
        this.logger.warn(
          {
            err: (err as Error).message,
            jid: metadata.jid,
            participantCount: metadata.participants?.length ?? 0,
          },
          'group_metadata callback failed',
        ),
      );
  }

  /**
   * Enqueue a history-sync event into the batch buffer. Triggers an immediate
   * flush if the buffer hits the batch-size threshold. Otherwise the idle
   * timer in `scheduleHistoryFlush` coalesces nearby events.
   *
   * Overflow handling: warn fires once on `false → true` transition. While
   * saturated, drops are silently counted and rolled up into a single warn
   * when the buffer drains below the cap. Avoids log floods under a real
   * outage where Baileys can emit thousands of events back-to-back.
   */
  private enqueueHistoryEvent(item: HistoryEventItem): void {
    this.historyBuffer.push(item);
    this.historyReceived += 1;
    this.historySyncActive = true;
    if (this.historyBuffer.length > HISTORY_BUFFER_HARD_CAP) {
      const drop = this.historyBuffer.length - HISTORY_BUFFER_HARD_CAP;
      this.historyBuffer.splice(0, drop);
      this.historyDroppedSinceOverflowStart += drop;
      if (!this.historyOverflowState) {
        this.historyOverflowState = true;
        this.logger.warn(
          { cap: HISTORY_BUFFER_HARD_CAP },
          'history buffer overflow, dropping oldest events (further drops suppressed until recovery)',
        );
      }
    }
    if (this.historyBuffer.length >= HISTORY_BATCH_SIZE) {
      this.flushHistory().catch((err: unknown) =>
        this.logger.warn({ err: (err as Error).message }, 'flushHistory failed (size threshold)'),
      );
    }
  }

  /**
   * Enqueue / replace a contact in the dedup map. `contacts.set` from Baileys
   * can deliver tens of thousands of entries; the same JID can be revisited
   * across `messaging-history.set` and `contacts.set`. Map keyed by `jid`
   * collapses repeats; last write wins.
   *
   * Overflow handling mirrors the history buffer: warn-once on saturation,
   * roll-up on recovery.
   */
  private enqueueContact(c: any, jid: string): void {
    const item: ContactItem = {
      jid,
      e164: jidToE164(jid),
      // why: `pushName` and `notify` are intentionally sourced from disjoint
      // chains. Sharing fallbacks made the two fields collapse to the same
      // value for almost every contact, defeating the purpose of carrying
      // both on the wire.
      pushName: (c.name as string | undefined) ?? (c.verifiedName as string | undefined) ?? null,
      notify: (c.notify as string | undefined) ?? null,
      verifiedName: (c.verifiedName as string | undefined) ?? null,
      profilePicUrl: null,
    };
    this.contactBuffer.set(jid, item);
    if (this.contactBuffer.size > CONTACT_BUFFER_HARD_CAP) {
      // Drop the oldest insertion-ordered entry. Map preserves insertion order;
      // we evict via `keys().next()`.
      const oldest = this.contactBuffer.keys().next().value as string | undefined;
      if (oldest !== undefined) {
        this.contactBuffer.delete(oldest);
        this.contactDroppedSinceOverflowStart += 1;
      }
      if (!this.contactOverflowState) {
        this.contactOverflowState = true;
        this.logger.warn(
          { cap: CONTACT_BUFFER_HARD_CAP },
          'contact buffer overflow, dropping oldest entries (further drops suppressed until recovery)',
        );
      }
    }
  }

  /**
   * Reset all per-run history-sync state. Called at the start of a new run
   * (detected via `historyLatestSeen` already true on the next
   * `messaging-history.set`). Without this, a non-loggedOut close that
   * triggers `bootBaileys` again would inherit the prior run's `latestSeen`
   * and flip the badge to "Sync complete" before the new run sends a single
   * event.
   */
  private resetHistorySyncState(): void {
    this.historyBuffer = [];
    this.contactBuffer = new Map();
    this.historyReceived = 0;
    this.historyLatestSeen = false;
    this.historySyncActive = false;
    this.historyFinalEmitted = false;
    this.historyOverflowState = false;
    this.historyDroppedSinceOverflowStart = 0;
    this.contactOverflowState = false;
    this.contactDroppedSinceOverflowStart = 0;
    this.historyBatchIndex = 0;
    this.logger.info({}, 'history sync state reset for new run');
  }

  /**
   * Arm or rearm the idle-window flush timer. When `force` is true the flush
   * happens on the next event-loop tick, used on the final `isLatest` batch
   * so the latest flag propagates without waiting the idle window.
   */
  private scheduleHistoryFlush(force: boolean): void {
    if (this.historyFlushTimer) {
      clearTimeout(this.historyFlushTimer);
      this.historyFlushTimer = null;
    }
    const delay = force ? 0 : HISTORY_FLUSH_IDLE_MS;
    this.historyFlushTimer = setTimeout(() => {
      this.historyFlushTimer = null;
      this.flushHistory().catch((err: unknown) =>
        this.logger.warn({ err: (err as Error).message }, 'flushHistory failed (idle)'),
      );
    }, delay);
  }

  /**
   * Drain history + contact buffers via the batch endpoint. Re-entrancy
   * guarded by `isFlushing` / `flushPending`: nested invocations (size
   * threshold mid-drain, or idle timer firing during a slow batch) defer to
   * the in-flight call and re-enter once on completion via `queueMicrotask`.
   *
   * Final-flush invariant: `isLatest: true` is emitted at most once per run.
   * The decision is made at end of drain when both buffers are empty AND
   * `historyLatestSeen` is set AND `historyFinalEmitted` is still false. We
   * fold the flag into the last `chat_event_batch` of the run when there's
   * something to send; otherwise we emit a single empty terminator batch so
   * the gateway can clear `historySyncProgress` deterministically.
   *
   * Errors are logged and swallowed, events may be re-delivered on the next
   * pair.
   */
  private async flushHistory(): Promise<void> {
    if (this.isFlushing) {
      this.flushPending = true;
      return;
    }
    this.isFlushing = true;
    try {
      // Drain loop. Each pass takes one slice from whichever buffer is
      // non-empty; `finalForRun` is computed AFTER the splice / drain so the
      // last `chat_event_batch` of the run carries `isLatest: true`. Contacts
      // never carry the `isLatest` flag, only the chat-event envelope does.
      while (this.historyBuffer.length > 0 || this.contactBuffer.size > 0) {
        if (this.historyBuffer.length > 0) {
          const slice = this.historyBuffer.splice(0, HISTORY_BATCH_SIZE);
          // Recovery roll-up, log once when the buffer drains below the cap.
          this.maybeLogHistoryOverflowRecovery();
          // why: `finalForRun` is true ONLY when this slice empties both
          // buffers AND we haven't already emitted the terminator. After a
          // re-entrant pending-flush re-runs, the second pass would otherwise
          // flip the flag again.
          const willBeEmptyAfter = this.historyBuffer.length === 0 && this.contactBuffer.size === 0;
          const finalForRun =
            this.historyLatestSeen && !this.historyFinalEmitted && willBeEmptyAfter;
          const batchIndex = this.historyBatchIndex;
          try {
            await this.gateway.batchCallback({
              kind: 'chat_event_batch',
              workerId: this.cfg.workerId,
              sessionId: this.sessionId,
              events: slice,
              isLatest: finalForRun,
              // why: marks this batch as part of the pre-pair history backfill so
              // slice 4 can apply a relaxed per-session rate limit. Additive on
              // the wire, the gateway batch route ignores unknown fields today
              // (Zod object parsing strips extras), so this is safe to ship.
              historySync: { historySync: true, sessionId: this.sessionId, batchIndex },
            });
            this.historyBatchIndex = batchIndex + 1;
            if (finalForRun) {
              this.historyFinalEmitted = true;
              this.markHistorySyncCompleted();
              this.markFirstPairCompleted();
            }
          } catch (err: unknown) {
            // why: the `gateway.batchCallback` retry policy has already
            // exhausted attempts. Restore the slice to the front of the
            // buffer so the next idle flush retries, without this the
            // spliced events would be lost. Schedule a deferred flush so we
            // back off rather than spinning.
            this.historyBuffer.unshift(...slice);
            this.scheduleHistoryFlush(false);
            this.logger.warn(
              { err: (err as Error).message, batchSize: slice.length, batchIndex },
              'chat_event_batch flush failed, slice restored, will retry on next idle window',
            );
            return;
          }
          continue;
        }

        // Contacts only, no `isLatest` semantics on this envelope.
        const contactSlice = Array.from(this.contactBuffer.values()).slice(0, CONTACT_BATCH_SIZE);
        for (const item of contactSlice) {
          this.contactBuffer.delete(item.jid);
        }
        this.maybeLogContactOverflowRecovery();
        try {
          await this.gateway.batchCallback({
            kind: 'contact_batch',
            workerId: this.cfg.workerId,
            sessionId: this.sessionId,
            contacts: contactSlice,
          });
        } catch (err: unknown) {
          // why: same restore-on-failure approach as the chat_event_batch
          // path. Use `has()` guard so a newer write for the same JID arrived
          // during the in-flight call wins (last-write-wins is the buffer's
          // contract; restore would otherwise stomp it).
          for (const item of contactSlice) {
            if (!this.contactBuffer.has(item.jid)) {
              this.contactBuffer.set(item.jid, item);
            }
          }
          this.scheduleHistoryFlush(false);
          this.logger.warn(
            { err: (err as Error).message, batchSize: contactSlice.length },
            'contact_batch flush failed, slice restored, will retry on next idle window',
          );
          return;
        }
      }

      // If `historyLatestSeen` was set during this drain but no events
      // remained to fold the flag into (rare: flag arrives on an empty final
      // batch), emit a single empty terminator so the gateway clears the
      // progress badge.
      if (this.historyLatestSeen && !this.historyFinalEmitted) {
        const batchIndex = this.historyBatchIndex;
        try {
          await this.gateway.batchCallback({
            kind: 'chat_event_batch',
            workerId: this.cfg.workerId,
            sessionId: this.sessionId,
            events: [],
            isLatest: true,
            historySync: { historySync: true, sessionId: this.sessionId, batchIndex },
          });
          this.historyBatchIndex = batchIndex + 1;
          this.historyFinalEmitted = true;
          this.markHistorySyncCompleted();
          this.markFirstPairCompleted();
        } catch (err: unknown) {
          this.logger.warn(
            { err: (err as Error).message, batchIndex },
            'chat_event_batch terminator flush failed',
          );
          // why: the terminator carries no events, marking sync complete
          // locally ensures the next heartbeat sends isLatest:true so the
          // gateway badge clears even if this request never arrives. We do
          // NOT mark `firstPairCompletedAt` on terminator failure, leaving
          // the flag unset means the next pair retries the backfill, which
          // is the documented intent.
          this.historyFinalEmitted = true;
          this.markHistorySyncCompleted();
        }
      }
    } finally {
      this.isFlushing = false;
      if (this.flushPending) {
        this.flushPending = false;
        // why: re-enter via microtask, not a direct `await`. A direct call
        // would deepen the stack on every pending flush; a `setTimeout(…, 0)`
        // would be visible to the heartbeat loop. Microtask runs after this
        // frame unwinds and before the next macrotask.
        queueMicrotask(() => {
          this.flushHistory().catch((err: unknown) =>
            this.logger.warn({ err: (err as Error).message }, 'flushHistory re-entry failed'),
          );
        });
      }
    }
  }

  private markHistorySyncCompleted(): void {
    if (this.historySyncActive) {
      this.historySyncJustCompleted = true;
      this.historySyncActive = false;
    }
  }

  /**
   * Persist the `firstPairCompletedAt` flag in the encrypted secret store.
   * Called once per session, after the terminator batch acknowledges. Idempotent
   * by design, a second call simply rewrites the same field with a fresh
   * timestamp; readers care only about presence.
   *
   * Persist failures are logged but do NOT throw. A worst-case write failure
   * means the next pair re-runs the backfill, which is safe (gateway dedups
   * on `(sessionId, waMessageId)`).
   */
  private markFirstPairCompleted(): void {
    if (!this.encKey) return;
    try {
      setFirstPairCompletedAt(this.encKey, this.sessionId, new Date().toISOString());
      this.logger.info(
        { received: this.historyReceived, batches: this.historyBatchIndex },
        'first pair history sync marked complete',
      );
    } catch (err: unknown) {
      this.logger.warn(
        { err: (err as Error).message },
        'firstPairCompletedAt persist failed, next pair will retry backfill',
      );
    }
  }

  /**
   * Track an emitted edit so the dual `messages.update` and `messages.upsert`
   * code paths don't double-emit. TTL prevents the set growing unbounded, * 5 minutes is well past the window in which both events can fire for the
   * same edit.
   */
  private rememberEmittedEdit(waMessageId: string): void {
    this.recentlyEmittedEditIds.add(waMessageId);
    const t = setTimeout(
      () => this.recentlyEmittedEditIds.delete(waMessageId),
      BaileysRuntime.EDIT_DEDUP_TTL_MS,
    );
    t.unref?.();
  }

  private maybeLogHistoryOverflowRecovery(): void {
    if (this.historyOverflowState && this.historyBuffer.length < HISTORY_BUFFER_HARD_CAP) {
      this.logger.warn(
        {
          dropped: this.historyDroppedSinceOverflowStart,
          cap: HISTORY_BUFFER_HARD_CAP,
        },
        'history sync buffer recovered, dropped N events while saturated',
      );
      this.historyOverflowState = false;
      this.historyDroppedSinceOverflowStart = 0;
    }
  }

  private maybeLogContactOverflowRecovery(): void {
    if (this.contactOverflowState && this.contactBuffer.size < CONTACT_BUFFER_HARD_CAP) {
      this.logger.warn(
        {
          dropped: this.contactDroppedSinceOverflowStart,
          cap: CONTACT_BUFFER_HARD_CAP,
        },
        'contact buffer recovered, dropped N entries while saturated',
      );
      this.contactOverflowState = false;
      this.contactDroppedSinceOverflowStart = 0;
    }
  }

  private startHeartbeat() {
    this.heartbeatTimer = setInterval(() => {
      // Surface history-sync progress on every heartbeat so the admin panel
      // can render a "Syncing… N messages" badge. After the final batch
      // flushes we emit one heartbeat with `isLatest: true` then null on the
      // next tick to clear the badge.
      let historySyncProgress: { received: number; isLatest: boolean } | null = null;
      if (this.historySyncActive) {
        historySyncProgress = { received: this.historyReceived, isLatest: false };
      } else if (this.historySyncJustCompleted) {
        historySyncProgress = { received: this.historyReceived, isLatest: true };
        this.historySyncJustCompleted = false;
      }

      this.gateway
        .callback({
          kind: 'heartbeat',
          workerId: this.cfg.workerId,
          sessionId: this.sessionId,
          status: this.status,
          phoneE164: this.phoneE164,
          version: process.env.npm_package_version ?? 'dev',
          queueDepth: 0,
          subscribed: this.outboundSubscribed,
          ...(historySyncProgress !== null ? { historySyncProgress } : {}),
        })
        .catch((err) => this.logger.warn({ err: err.message }, 'heartbeat failed'));
    }, HEARTBEAT_INTERVAL_MS);
  }

  private startConfigRefresh() {
    this.configRefreshTimer = setInterval(() => {
      this.gateway
        .getSessionConfig(this.sessionId)
        .then((c) => {
          if (this.sendReadReceipts !== c.sendReadReceipts) {
            this.logger.info({ sendReadReceipts: c.sendReadReceipts }, 'session config changed');
          }
          this.sendReadReceipts = c.sendReadReceipts;
          // syncFullHistory is read by Baileys once at makeWASocket time, so a
          // change here doesn't take effect until next bootBaileys (i.e. the
          // next reconnect or auto-reset). We still mirror it locally so the
          // next boot picks up the new value without a worker restart.
          if (this.syncFullHistory !== c.syncFullHistory) {
            this.logger.info(
              { syncFullHistory: c.syncFullHistory },
              'syncFullHistory toggle changed, takes effect on next pair / reconnect',
            );
            this.syncFullHistory = c.syncFullHistory;
          }
        })
        .catch((err) =>
          this.logger.warn({ err: err.message }, 'config refresh failed, keeping previous value'),
        );
    }, CONFIG_REFRESH_INTERVAL_MS);
  }

  private async drainPending(): Promise<void> {
    const listKey = `wa:pending:${this.sessionId}`;
    while (true) {
      const raw = await this.redisOps.rpop(listKey);
      if (!raw) break;
      await this.handleIncomingWire(`wa:outbound:${this.sessionId}`, raw, true).catch((err) =>
        this.logger.warn({ err: err.message }, 'drain handle failed'),
      );
    }
  }

  private async handleIncomingWire(
    _channel: string,
    message: string,
    isDrain = false,
  ): Promise<void> {
    let env: WireEnvelope;
    try {
      env = JSON.parse(message) as WireEnvelope;
    } catch {
      return;
    }

    if (env.kind !== 'send' && env.kind !== 'react' && env.kind !== 'presence') {
      // Unknown envelope kinds are dropped silently.
      return;
    }

    // Timestamp window.
    const delta = Math.abs(Date.now() - Date.parse(env.at));
    if (!Number.isFinite(delta)) {
      this.logger.warn({ kind: env.kind, messageId: env.messageId }, 'invalid timestamp, dropped');
      return;
    }
    if (delta > 60_000 && !isDrain) {
      this.logger.warn({ kind: env.kind, messageId: env.messageId }, 'stale timestamp, dropped');
      return;
    }
    if (delta > 60_000 && isDrain) {
      this.logger.info(
        { messageId: env.messageId, deltaMs: delta },
        'drain replay accepted past freshness window',
      );
    }

    // HMAC verify.
    if (!this.gateway.verifyInbound(env)) {
      this.logger.warn({ kind: env.kind, messageId: env.messageId }, 'bad signature, dropped');
      return;
    }

    // Dedup via messageId with 7-day TTL. Only for 'send' and 'react' wires
    // (presence has no durable messageId concept). This prevents replays when
    // the pending list is drained after worker restart.
    if (env.kind === 'send' || env.kind === 'react') {
      const msgKey = `wa:msg-processed:${this.sessionId}:${env.messageId}`;
      const msgRes = await this.redisOps.set(msgKey, '1', 'EX', MSG_DEDUP_TTL_S, 'NX');
      if (msgRes !== 'OK') {
        this.logger.info(
          { kind: env.kind, messageId: env.messageId, isDrain },
          'message already processed, replay skipped',
        );
        return;
      }
    }

    // Dedup via Redis Set with TTL ~600s equivalent.
    const setKey = `${PROCESSED_SET_KEY(this.sessionId)}:${env.nonce}`;
    const res = await this.redisOps.set(setKey, '1', 'EX', 600, 'NX');
    if (res !== 'OK') {
      this.logger.info({ kind: env.kind, messageId: env.messageId }, 'duplicate nonce, skipped');
      return;
    }

    if (env.kind === 'send') {
      await this.handleSend(env, message);
      return;
    }
    if (env.kind === 'react') {
      await this.handleReact(env, message);
      return;
    }
    if (env.kind === 'presence') {
      await this.handlePresence(env);
      return;
    }
  }

  private async handleSend(env: WireSend, rawWire: string): Promise<void> {
    this.logger.info(
      {
        messageId: env.messageId,
        projectId: env.projectId,
        purpose: env.purpose,
      },
      'handling send',
    );
    try {
      const jid = toJid(env.to);
      const opts = env.quoted
        ? ({
            quoted: {
              key: {
                remoteJid: jid,
                fromMe: env.quoted.fromMe,
                id: env.quoted.waMessageId,
                ...(env.quoted.participantJid ? { participant: env.quoted.participantJid } : {}),
              },
              // Baileys reads `key` for the inline quote rendering; `message`
              // is required by the type but its content is not user-visible.
              message: { conversation: '' },
            },
          } as any)
        : undefined;

      let sent: proto.WebMessageInfo | undefined;
      if (env.body.kind === 'text') {
        sent = await this.sock?.sendMessage(jid, { text: env.body.text }, opts);
      } else if (env.body.kind === 'image') {
        sent = await this.sock?.sendMessage(
          jid,
          { image: { url: env.body.url }, caption: env.body.caption },
          opts,
        );
      } else if (env.body.kind === 'document') {
        sent = await this.sock?.sendMessage(
          jid,
          {
            document: { url: env.body.url },
            fileName: env.body.filename,
            caption: env.body.caption,
          },
          opts,
        );
      }
      const waMessageId = sent?.key?.id ?? undefined;
      if (waMessageId) {
        const id = waMessageId;
        this.ownSentIds.add(id);
        // Keep the content so `getMessage` can answer a decrypt-retry for it.
        if (sent?.message) this.sentMessages.set(id, sent.message);
        const t = setTimeout(() => this.ownSentIds.delete(id), BaileysRuntime.OWN_SENT_TTL_MS);
        t.unref?.();
      }
      await this.gateway.callback({
        kind: 'send_ack',
        messageId: env.messageId,
        waMessageId,
        ok: true,
      });
      // why: terminal ack for sync-confirm-send; gateway awaits this on a fresh subscriber.
      await this.redisOps
        .publish(
          `wa:ack:${env.messageId}`,
          JSON.stringify({
            messageId: env.messageId,
            status: 'sent',
            ...(waMessageId ? { waMessageId } : {}),
            ts: new Date().toISOString(),
          } satisfies SendAckEnvelope),
        )
        .catch((err) =>
          this.logger.warn(
            { err: (err as Error).message, messageId: env.messageId },
            'wa:ack publish failed',
          ),
        );
      // Remove this wire from the durable pending list (best-effort).
      // The list+pubsub dual-write means the list accumulates copies of
      // messages that pub/sub handled in real-time; without this LREM the
      // list grows until the next drainPending() empties it.
      // Done after sock.sendMessage to ensure we only remove successfully-
      // sent wires.
      this.redisOps
        .lrem(`wa:pending:${this.sessionId}`, 1, rawWire)
        .catch((err) =>
          this.logger.warn(
            { err: (err as Error).message, messageId: env.messageId },
            'lrem pending failed (non-fatal)',
          ),
        );
    } catch (err) {
      await this.gateway
        .callback({
          kind: 'send_ack',
          messageId: env.messageId,
          ok: false,
          code: 'SEND_FAILED',
          detail: (err as Error).message,
        })
        .catch(() => {});
      await this.redisOps
        .publish(
          `wa:ack:${env.messageId}`,
          JSON.stringify({
            messageId: env.messageId,
            status: 'failed',
            errorCode: 'SEND_FAILED',
            ts: new Date().toISOString(),
          } satisfies SendAckEnvelope),
        )
        .catch((pubErr) =>
          this.logger.warn(
            { err: (pubErr as Error).message, messageId: env.messageId },
            'wa:ack publish failed',
          ),
        );
    }
  }

  private async handleReact(env: WireReact, rawWire: string): Promise<void> {
    try {
      const reactionMessage = {
        react: {
          text: env.emoji, // empty string clears
          key: {
            remoteJid: env.waJid,
            fromMe: env.targetFromMe,
            id: env.targetWaMessageId,
          },
        },
      };
      await this.sock?.sendMessage(env.waJid, reactionMessage);
      // The gateway's send_ack handler tolerates unknown messageIds
      // (reaction op ids aren't in the messages collection, so updateStatus
      // is a no-op and findByMessageId returns null, no webhook fires,
      // which is the correct behaviour for reaction acks).
      await this.gateway.callback({
        kind: 'send_ack',
        messageId: env.messageId,
        ok: true,
      });
      // Remove this wire from the durable pending list (best-effort).
      this.redisOps
        .lrem(`wa:pending:${this.sessionId}`, 1, rawWire)
        .catch((err) =>
          this.logger.warn(
            { err: (err as Error).message, messageId: env.messageId },
            'lrem pending failed (non-fatal)',
          ),
        );
    } catch (err) {
      this.logger.warn({ err: (err as Error).message, messageId: env.messageId }, 'react failed');
      await this.gateway
        .callback({
          kind: 'send_ack',
          messageId: env.messageId,
          ok: false,
          code: 'REACT_FAILED',
          detail: (err as Error).message,
        })
        .catch(() => {});
    }
  }

  private async handlePresence(env: WirePresence): Promise<void> {
    // Fire-and-forget, never throws out of the dispatcher; failures are logged.
    try {
      if (env.waJid) {
        await this.sock?.presenceSubscribe?.(env.waJid);
        await this.sock?.sendPresenceUpdate?.(env.state, env.waJid);
      } else {
        await this.sock?.sendPresenceUpdate?.(env.state);
      }
    } catch (err) {
      this.logger.warn(
        { err: (err as Error).message, state: env.state, hasTarget: Boolean(env.waJid) },
        'presence update failed',
      );
    }
  }
}

function toJid(e164: string): string {
  if (e164.includes('@')) return e164;
  const digits = e164.replace(/^\+/, '');
  return `${digits}@s.whatsapp.net`;
}

/**
 * Convert a WhatsApp JID back to an E.164 phone number.
 * Returns null for groups (`@g.us`), broadcasts, or malformed input.
 * Mirrors `toJid`.
 */
function jidToE164(jid: string): string | null {
  if (!jid.endsWith('@s.whatsapp.net')) return null;
  const at = jid.indexOf('@');
  const localPart = jid.slice(0, at);
  const colon = localPart.indexOf(':');
  const digits = colon === -1 ? localPart : localPart.slice(0, colon);
  if (!/^\d{6,15}$/.test(digits)) return null;
  return `+${digits}`;
}

/**
 * Translate an `@lid` JID to its `@s.whatsapp.net` (PN) form at the ingress
 * boundary. Baileys v7 auto-populates the LID → PN mapping during
 * `decode-wa-message` (storeLIDPNMappings), so for any live `messages.upsert`
 * the entry should already exist. For `messaging-history.set` rows the
 * mapping may not yet be populated, in that case (or on any other failure)
 * we soft-fail: return the original JID and warn, so downstream consumers
 * still see the event rather than throwing.
 *
 * Non-LID inputs (groups, broadcasts, `@s.whatsapp.net`) pass through
 * unchanged, only `@lid` is translated.
 *
 * `sock` is typed as `any` here to match the field type on the runtime and
 * to keep the helper resilient to v7 type churn; in practice v7's
 * `WASocket` carries a required `signalRepository.lidMapping` (see
 * `SignalRepositoryWithLIDStore` in `@whiskeysockets/baileys`).
 */
async function resolveJid(sock: any, jid: string, logger: pino.Logger): Promise<string> {
  if (!jid.endsWith('@lid')) return jid;
  const lidMapping = sock?.signalRepository?.lidMapping;
  if (!lidMapping || typeof lidMapping.getPNForLID !== 'function') {
    logger.warn({ jid }, 'lid mapping unavailable on signalRepository');
    return jid;
  }
  try {
    const pn = await lidMapping.getPNForLID(jid);
    if (!pn) {
      logger.warn({ jid }, 'lid mapping unresolved');
      return jid;
    }
    return pn;
  } catch (err) {
    logger.warn({ jid, err: (err as Error).message }, 'lid mapping lookup failed');
    return jid;
  }
}

/**
 * Convert Baileys' `messageTimestamp` (Long or number, seconds since epoch)
 * to an ISO-8601 string. Falls back to "now" when the field is missing or
 * unparseable, the wire schema requires a valid ISO timestamp.
 */
function baileysTimestampToIso(t: unknown): string {
  let secs: number | null = null;
  if (typeof t === 'number') {
    secs = t;
  } else if (t && typeof (t as { toNumber?: () => number }).toNumber === 'function') {
    try {
      secs = (t as { toNumber: () => number }).toNumber();
    } catch {
      secs = null;
    }
  } else if (typeof t === 'string' && /^\d+$/.test(t)) {
    secs = Number(t);
  }
  if (secs === null || !Number.isFinite(secs) || secs <= 0) {
    return new Date().toISOString();
  }
  return new Date(secs * 1000).toISOString();
}

/**
 * Convert a Baileys unix-seconds timestamp field (`creation`, `subjectTime`)
 * to an ISO-8601 string with offset, or `undefined` when absent/unparseable.
 * Unlike `baileysTimestampToIso` (used for message timestamps, which the wire
 * schema requires), these fields are optional on `GroupMetadataSchema`, we
 * must not fabricate a "now" fallback for data WA never actually supplied.
 */
function baileysSecondsToIsoOrUndefined(t: unknown): string | undefined {
  let secs: number | null = null;
  if (typeof t === 'number') {
    secs = t;
  } else if (t && typeof (t as { toNumber?: () => number }).toNumber === 'function') {
    try {
      secs = (t as { toNumber: () => number }).toNumber();
    } catch {
      secs = null;
    }
  } else if (typeof t === 'string' && /^\d+$/.test(t)) {
    secs = Number(t);
  }
  if (secs === null || !Number.isFinite(secs) || secs <= 0) return undefined;
  return new Date(secs * 1000).toISOString();
}

/**
 * Map a raw Baileys `GroupMetadata` record onto the wire/db `GroupMetadata`
 * shape (`packages/protocol/src/db.ts`). Two deliberate translations:
 *   - Baileys names the participant identifier `id`; our schema calls it
 *     `jid`.
 *   - Baileys' `subjectTime`/`creation` are unix seconds; our schema wants
 *     ISO 8601 with offset.
 * Every field bar `jid` is optional on the wire schema, so missing Baileys
 * fields (community-linked groups omit `owner`, for example) pass through
 * as `undefined` rather than being coerced to a sentinel.
 */
function mapBaileysGroupMetadata(raw: any): WireGroupMetadata {
  const participants = Array.isArray(raw?.participants)
    ? raw.participants
        .filter((p: any) => typeof p?.id === 'string' && p.id.length > 0)
        .map((p: any) => ({
          jid: p.id as string,
          // Pass through as Baileys reports it: `null` means "confirmed plain
          // member", `undefined` means "role unknown". Do not coerce one into
          // the other, GroupParticipantSchema's doc comment depends on this.
          admin: p.admin as 'admin' | 'superadmin' | null | undefined,
        }))
    : undefined;
  return {
    jid: raw.id,
    subject: typeof raw.subject === 'string' ? raw.subject : undefined,
    subjectOwner: typeof raw.subjectOwner === 'string' ? raw.subjectOwner : undefined,
    subjectTime: baileysSecondsToIsoOrUndefined(raw.subjectTime),
    creation: baileysSecondsToIsoOrUndefined(raw.creation),
    owner: typeof raw.owner === 'string' ? raw.owner : undefined,
    desc: typeof raw.desc === 'string' ? raw.desc : undefined,
    descId: typeof raw.descId === 'string' ? raw.descId : undefined,
    announce: typeof raw.announce === 'boolean' ? raw.announce : undefined,
    restrict: typeof raw.restrict === 'boolean' ? raw.restrict : undefined,
    size: typeof raw.size === 'number' ? raw.size : undefined,
    ephemeralDuration:
      typeof raw.ephemeralDuration === 'number' ? raw.ephemeralDuration : undefined,
    inviteCode: typeof raw.inviteCode === 'string' ? raw.inviteCode : undefined,
    participants,
  };
}

/**
 * Derive a `ChatEventContent` from a raw Baileys WAMessage. Stores metadata
 * only, media bytes are not attached here. `media.unavailable` is set at
 * construction from `opts.historySync`: history-sync rows never have the
 * media bytes available, while the live path keeps them in-band.
 *
 * Constructor-time setting (rather than caller mutation) means the live and
 * history-sync paths can't accidentally produce different shapes for the
 * same message.
 */
/**
 * Strip Baileys envelope wrappers so the content classifier sees the real
 * payload. Disappearing-messages, view-once, and edits all nest the actual
 * message one level deeper; without unwrapping, every such message would be
 * classified as `'other'` and render as `[Attachment]` in the admin viewer.
 */
function unwrapBaileysMessage(msg: any): any {
  if (!msg) return msg;
  return (
    msg.ephemeralMessage?.message ??
    msg.viewOnceMessage?.message ??
    msg.viewOnceMessageV2?.message ??
    msg.viewOnceMessageV2Extension?.message ??
    msg.editedMessage?.message ??
    msg.documentWithCaptionMessage?.message ??
    msg
  );
}

/**
 * Map a Baileys `editedMessage` payload onto the slice-1 `MessageRevisionBody`
 * shape. Baileys nests the new content one level deeper than the original
 * (`editedMessage.message.<concrete>`); we unwrap the same way the chat-event
 * extractor does, then narrow on the concrete kind. Falls through to `'other'`
 * for unrecognised kinds rather than throwing, the revision row still records
 * that an edit happened, even if the body shape isn't classified.
 */
function extractRevisionBody(editedMessage: unknown): {
  kind: 'text' | 'image' | 'document' | 'audio' | 'video' | 'sticker' | 'other';
  text?: string;
  caption?: string;
  mediaFileName?: string;
} {
  const wrapper = editedMessage as { message?: any } | undefined;
  const inner = unwrapBaileysMessage(wrapper?.message ?? wrapper);
  if (!inner) return { kind: 'other' };
  const text: string | undefined =
    inner.conversation ?? inner.extendedTextMessage?.text ?? undefined;
  if (text) return { kind: 'text', text };
  if (inner.imageMessage) {
    return { kind: 'image', caption: inner.imageMessage.caption };
  }
  if (inner.documentMessage) {
    return {
      kind: 'document',
      caption: inner.documentMessage.caption,
      mediaFileName: inner.documentMessage.fileName,
    };
  }
  if (inner.audioMessage) return { kind: 'audio' };
  if (inner.videoMessage) return { kind: 'video', caption: inner.videoMessage.caption };
  if (inner.stickerMessage) return { kind: 'sticker' };
  return { kind: 'other' };
}

function extractChatEventContent(
  m: any,
  opts: { historySync: boolean },
): {
  kind: 'text' | 'image' | 'document' | 'audio' | 'video' | 'sticker' | 'other';
  text?: string;
  media?: {
    kind: string;
    caption?: string;
    filename?: string;
    unavailable: boolean;
  };
} {
  const msg = unwrapBaileysMessage(m?.message);
  if (!msg) return { kind: 'other' };

  const text: string | undefined = msg.conversation ?? msg.extendedTextMessage?.text ?? undefined;
  if (text) {
    return { kind: 'text', text };
  }

  const unavailable = opts.historySync;

  if (msg.imageMessage) {
    return {
      kind: 'image',
      media: {
        kind: 'image',
        caption: msg.imageMessage.caption,
        unavailable,
      },
    };
  }
  if (msg.documentMessage) {
    return {
      kind: 'document',
      media: {
        kind: 'document',
        caption: msg.documentMessage.caption,
        filename: msg.documentMessage.fileName,
        unavailable,
      },
    };
  }
  if (msg.audioMessage) {
    return {
      kind: 'audio',
      media: { kind: 'audio', unavailable },
    };
  }
  if (msg.videoMessage) {
    return {
      kind: 'video',
      media: {
        kind: 'video',
        caption: msg.videoMessage.caption,
        unavailable,
      },
    };
  }
  if (msg.stickerMessage) {
    return {
      kind: 'sticker',
      media: { kind: 'sticker', unavailable },
    };
  }
  return { kind: 'other' };
}

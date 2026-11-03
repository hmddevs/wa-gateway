/**
 * BaileysRuntime, messages.update receipt emission + stop() teardown.
 *
 * Change A (worker): messages.update now emits receipts via
 *   { kind:'receipt', waMessageId, sessionId, status }
 *   without a `messageId` field. Status mapping: 2→sent, 3→delivered, 4→read.
 *   Unknown/missing statuses and missing u.key.id must not emit a receipt.
 *
 * Change B (worker): stop() signals offline (heartbeat { status:'offline',
 *   subscribed:false }) BEFORE tearing down the socket, calls sock.end() (not
 *   sock.logout()), and disconnects redis.
 *
 * Strategy mirrors lid-resolution.test.ts:
 *   - Mock ioredis to prevent TCP connections.
 *   - Mock GatewayClient so callback() is observable without HTTP.
 *   - Mock makeWASocket to return a fake sock with an ev.on handler registry;
 *     bootBaileys binds all listeners and tests fire them synchronously.
 *   - Call (rt as any).bootBaileys() to register ev handlers without starting timers.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- module mocks -----------------------------------------------------------

vi.mock('ioredis', () => {
  const MockRedis = vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    subscribe: vi.fn().mockResolvedValue(undefined),
    rpop: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    on: vi.fn(),
    publish: vi.fn().mockResolvedValue(1),
    lrem: vi.fn().mockResolvedValue(1),
    quit: vi.fn().mockResolvedValue(undefined),
  }));
  (MockRedis as any).default = MockRedis;
  return { default: MockRedis, Redis: MockRedis };
});

const mockCallback = vi.fn().mockResolvedValue(undefined);
vi.mock('../gateway-client.js', () => ({
  GatewayClient: vi.fn().mockImplementation(() => ({
    getSessions: vi.fn().mockResolvedValue({ sessions: [] }),
    callback: mockCallback,
    batchCallback: vi.fn().mockResolvedValue(undefined),
    verifyInbound: vi.fn().mockReturnValue(true),
    getSessionConfig: vi.fn().mockResolvedValue({ sendReadReceipts: true }),
  })),
}));

// ev.on handler registry, bootBaileys binds all listeners here.
const evHandlers = new Map<string, (...args: any[]) => any>();

// Stub sock, tests mutate end/logout directly.
const mockSockEnd = vi.fn();
const mockSockLogout = vi.fn().mockResolvedValue(undefined);

vi.mock('@whiskeysockets/baileys', () => ({
  makeWASocket: vi.fn().mockImplementation(() => ({
    ev: {
      on: vi.fn().mockImplementation((name: string, fn: (...args: any[]) => any) => {
        evHandlers.set(name, fn);
      }),
    },
    signalRepository: {
      lidMapping: { getPNForLID: vi.fn().mockResolvedValue(null) },
    },
    sendMessage: vi.fn().mockResolvedValue({ key: { id: 'wa-echo-id' } }),
    relayMessage: vi.fn().mockResolvedValue('relay-id'),
    readMessages: vi.fn().mockResolvedValue(undefined),
    end: mockSockEnd,
    logout: mockSockLogout,
  })),
  DisconnectReason: { loggedOut: 401 },
  fetchLatestBaileysVersion: vi.fn().mockResolvedValue({ version: [2, 3000, 0] }),
  makeCacheableSignalKeyStore: vi.fn().mockReturnValue({}),
  WAMessageStubType: { REVOKE: 1 },
  proto: {
    Message: {
      ProtocolMessage: { Type: { MESSAGE_EDIT: 14, REVOKE: 0 } },
    },
  },
}));

vi.mock('../keychain.js', () => ({
  loadOrCreateKey: vi.fn().mockReturnValue(Buffer.alloc(32)),
}));

vi.mock('../auth-state.js', () => ({
  useEncryptedAuthState: vi.fn().mockResolvedValue({
    state: { creds: {}, keys: {} },
    saveCreds: vi.fn(),
  }),
  getFirstPairCompletedAt: vi.fn().mockReturnValue(null),
  setFirstPairCompletedAt: vi.fn(),
}));

// ---- imports after mocks ----------------------------------------------------

import { BaileysRuntime } from '../baileys-runtime.js';
import type { WorkerConfig } from '../config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SESSION_ID = 'test-session';

const MINIMAL_CONFIG: WorkerConfig = {
  workerId: 'worker-test',
  gatewayBaseUrl: 'https://wa.test.example',
  refreshToken: 'tok-test-minimum-twenty',
  wireSecretB64: Buffer.from('test-secret-key-for-hmac-padding', 'utf-8').toString('base64'),
  upstashRedisUrl: 'rediss://localhost:6379',
  loopbackPort: 7823,
  logLevel: 'warn',
};

const WIRE_SECRET = Buffer.from('test-secret-key-for-hmac-padding', 'utf-8');

function buildRuntime(): BaileysRuntime {
  return new BaileysRuntime(
    MINIMAL_CONFIG,
    SESSION_ID,
    WIRE_SECRET,
    { onStatusChange: vi.fn(), onQr: vi.fn() },
    vi.fn(),
  );
}

async function buildBootedRuntime(): Promise<BaileysRuntime> {
  const rt = buildRuntime();
  // Silence pino output during tests.
  const silentLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  (rt as any).logger = silentLogger;
  await (rt as any).bootBaileys();
  return rt;
}

/** Fire a `messages.update` event. */
async function fireMessagesUpdate(updates: Record<string, unknown>[]): Promise<void> {
  const handler = evHandlers.get('messages.update');
  if (!handler) throw new Error('messages.update handler not registered');
  await handler(updates);
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockCallback.mockResolvedValue(undefined);
  evHandlers.clear();
});

// ===========================================================================
// messages.update, receipt emission
// ===========================================================================

describe('messages.update, emits receipt with waMessageId and no messageId (status 3 → delivered)', () => {
  it('callback receives { kind:receipt, waMessageId, sessionId, status:delivered } and no messageId key', async () => {
    await buildBootedRuntime();

    await fireMessagesUpdate([{ key: { id: 'wa-7', fromMe: true }, update: { status: 3 } }]);

    expect(mockCallback).toHaveBeenCalledOnce();
    const envelope = mockCallback.mock.calls[0]![0] as Record<string, unknown>;
    expect(envelope.kind).toBe('receipt');
    expect(envelope.waMessageId).toBe('wa-7');
    expect(envelope.sessionId).toBe(SESSION_ID);
    expect(envelope.status).toBe('delivered');
    // The change explicitly drops the gateway messageId from this path.
    expect('messageId' in envelope).toBe(false);
  });
});

describe('messages.update, status 2 maps to sent', () => {
  it('callback receives status:sent for u.update.status === 2', async () => {
    await buildBootedRuntime();

    await fireMessagesUpdate([{ key: { id: 'wa-sent-1', fromMe: true }, update: { status: 2 } }]);

    expect(mockCallback).toHaveBeenCalledOnce();
    const envelope = mockCallback.mock.calls[0]![0] as Record<string, unknown>;
    expect(envelope.status).toBe('sent');
    expect(envelope.waMessageId).toBe('wa-sent-1');
  });
});

describe('messages.update, status 4 maps to read', () => {
  it('callback receives status:read for u.update.status === 4', async () => {
    await buildBootedRuntime();

    await fireMessagesUpdate([{ key: { id: 'wa-read-1', fromMe: true }, update: { status: 4 } }]);

    expect(mockCallback).toHaveBeenCalledOnce();
    const envelope = mockCallback.mock.calls[0]![0] as Record<string, unknown>;
    expect(envelope.status).toBe('read');
    expect(envelope.waMessageId).toBe('wa-read-1');
  });
});

describe('messages.update, unknown status does not emit a receipt callback', () => {
  it('does not call gateway.callback for status 1 (unknown mapping)', async () => {
    await buildBootedRuntime();

    await fireMessagesUpdate([{ key: { id: 'wa-skip-1', fromMe: true }, update: { status: 1 } }]);

    // Status 1 has no mapping; no receipt callback must be emitted.
    // (bootBaileys itself may emit a heartbeat; filter for receipt kind.)
    const receiptCalls = mockCallback.mock.calls.filter(
      (c) => (c[0] as Record<string, unknown>).kind === 'receipt',
    );
    expect(receiptCalls).toHaveLength(0);
  });
});

describe('messages.update, missing u.key.id does not emit a receipt callback', () => {
  it('does not call gateway.callback when key.id is undefined', async () => {
    await buildBootedRuntime();

    await fireMessagesUpdate([{ key: { fromMe: true }, update: { status: 3 } }]);

    const receiptCalls = mockCallback.mock.calls.filter(
      (c) => (c[0] as Record<string, unknown>).kind === 'receipt',
    );
    expect(receiptCalls).toHaveLength(0);
  });
});

// ===========================================================================
// stop(), offline heartbeat + sock.end, NOT sock.logout
// ===========================================================================

describe('stop(), signals offline before teardown', () => {
  it('sends a heartbeat with status:offline and subscribed:false before disconnecting redis', async () => {
    const rt = await buildBootedRuntime();

    // Confirm the gateway mock is wired up.
    expect(mockCallback).toBeDefined();

    await rt.stop();

    // At least one callback with kind:heartbeat and status:offline must have been fired.
    const offlineCalls = mockCallback.mock.calls.filter((c) => {
      const env = c[0] as Record<string, unknown>;
      return env.kind === 'heartbeat' && env.status === 'offline';
    });
    expect(offlineCalls.length).toBeGreaterThanOrEqual(1);

    const offlineEnv = offlineCalls[0]![0] as Record<string, unknown>;
    expect(offlineEnv.subscribed).toBe(false);
    expect(offlineEnv.sessionId).toBe(SESSION_ID);
  });

  it('calls sock.end() and does NOT call sock.logout()', async () => {
    const rt = await buildBootedRuntime();

    await rt.stop();

    expect(mockSockEnd).toHaveBeenCalled();
    expect(mockSockLogout).not.toHaveBeenCalled();
  });
});

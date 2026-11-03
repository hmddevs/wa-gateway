/**
 * BaileysRuntime, Baileys → protocol `GroupMetadata` mapping
 * (`mapBaileysGroupMetadata`, private to baileys-runtime.ts).
 *
 * Not directly exported, so exercised indirectly via the real trigger path:
 * `connection: 'open'` → `fetchAndPushAllGroupMetadata()` →
 * `sock.groupFetchAllParticipating()` → `gateway.batchCallback({ kind:
 * 'group_metadata_batch', items })`. Covers the two deliberate translations
 * documented on the function:
 *   - participant `id` (Baileys) → `jid` (our schema)
 *   - `subjectTime`/`creation` unix SECONDS (Baileys) → ISO 8601 (wire)
 *
 * Strategy mirrors receipt-emit.test.ts:
 *   - Mock ioredis to prevent TCP connections.
 *   - Mock GatewayClient so batchCallback() is observable without HTTP.
 *   - Mock makeWASocket to return a fake sock with an ev.on handler registry
 *     plus groupFetchAllParticipating(); bootBaileys binds all listeners and
 *     tests fire them synchronously.
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
const mockBatchCallback = vi.fn().mockResolvedValue(undefined);
vi.mock('../gateway-client.js', () => ({
  GatewayClient: vi.fn().mockImplementation(() => ({
    getSessions: vi.fn().mockResolvedValue({ sessions: [] }),
    callback: mockCallback,
    batchCallback: mockBatchCallback,
    verifyInbound: vi.fn().mockReturnValue(true),
    getSessionConfig: vi.fn().mockResolvedValue({ sendReadReceipts: true }),
  })),
}));

// ev.on handler registry, bootBaileys binds all listeners here.
const evHandlers = new Map<string, (...args: any[]) => any>();

// Populated per-test before firing `connection: 'open'`.
let mockGroupFetchAllParticipating = vi.fn().mockResolvedValue({});

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
    groupFetchAllParticipating: (...args: unknown[]) => mockGroupFetchAllParticipating(...args),
    end: vi.fn(),
    logout: vi.fn().mockResolvedValue(undefined),
    user: { id: '447700900000:1@s.whatsapp.net' },
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
  loopbackPort: 7824,
  logLevel: 'warn',
} as WorkerConfig;

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

/** Fire `connection.update` with `connection: 'open'` and flush microtasks, *  `fetchAndPushAllGroupMetadata()` is fire-and-forget from that handler. */
async function fireConnectionOpen(): Promise<void> {
  const handler = evHandlers.get('connection.update');
  if (!handler) throw new Error('connection.update handler not registered');
  await handler({ connection: 'open' });
  // Flush the fire-and-forget groupFetchAllParticipating().then(batchCallback) chain.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockCallback.mockResolvedValue(undefined);
  mockBatchCallback.mockResolvedValue(undefined);
  mockGroupFetchAllParticipating = vi.fn().mockResolvedValue({});
  evHandlers.clear();
});

// ===========================================================================
// connection: open, mapBaileysGroupMetadata via the real push path
// ===========================================================================

describe('connection open, maps a raw Baileys GroupMetadata participant id to jid', () => {
  it('pushes participants with { jid, admin } derived from Baileys { id, admin }', async () => {
    mockGroupFetchAllParticipating = vi.fn().mockResolvedValue({
      '120363000000000001@g.us': {
        id: '120363000000000001@g.us',
        subject: 'HMD Ops',
        participants: [
          { id: '447700900001@s.whatsapp.net', admin: 'superadmin' },
          { id: '447700900002@s.whatsapp.net', admin: null },
        ],
      },
    });

    await buildBootedRuntime();
    await fireConnectionOpen();

    expect(mockBatchCallback).toHaveBeenCalledOnce();
    const [envelope] = mockBatchCallback.mock.calls[0] as [Record<string, unknown>];
    expect(envelope.kind).toBe('group_metadata_batch');
    const items = envelope.items as Array<{ metadata: Record<string, unknown> }>;
    expect(items).toHaveLength(1);
    expect(items[0]!.metadata.jid).toBe('120363000000000001@g.us');
    expect(items[0]!.metadata.participants).toEqual([
      { jid: '447700900001@s.whatsapp.net', admin: 'superadmin' },
      { jid: '447700900002@s.whatsapp.net', admin: null },
    ]);
  });
});

describe('connection open, maps subjectTime and creation from unix seconds to ISO 8601', () => {
  it('converts both fields from Baileys unix-seconds numbers to ISO datetime strings', async () => {
    const subjectTimeSecs = 1_753_000_000; // 2025-07-20T10:26:40.000Z
    const creationSecs = 1_700_000_000; // 2023-11-14T22:13:20.000Z

    mockGroupFetchAllParticipating = vi.fn().mockResolvedValue({
      '120363000000000002@g.us': {
        id: '120363000000000002@g.us',
        subjectTime: subjectTimeSecs,
        creation: creationSecs,
      },
    });

    await buildBootedRuntime();
    await fireConnectionOpen();

    expect(mockBatchCallback).toHaveBeenCalledOnce();
    const [envelope] = mockBatchCallback.mock.calls[0] as [Record<string, unknown>];
    const items = envelope.items as Array<{ metadata: Record<string, unknown> }>;
    expect(items[0]!.metadata.subjectTime).toBe(new Date(subjectTimeSecs * 1000).toISOString());
    expect(items[0]!.metadata.creation).toBe(new Date(creationSecs * 1000).toISOString());
  });
});

describe('connection open, no participants on a group omits the field rather than coercing', () => {
  it('leaves participants undefined when Baileys reports none', async () => {
    mockGroupFetchAllParticipating = vi.fn().mockResolvedValue({
      '120363000000000003@g.us': { id: '120363000000000003@g.us', subject: 'No roster' },
    });

    await buildBootedRuntime();
    await fireConnectionOpen();

    const [envelope] = mockBatchCallback.mock.calls[0] as [Record<string, unknown>];
    const items = envelope.items as Array<{ metadata: Record<string, unknown> }>;
    expect(items[0]!.metadata.participants).toBeUndefined();
  });
});

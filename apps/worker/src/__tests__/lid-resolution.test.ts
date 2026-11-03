/**
 * LID → PN translation layer, regression tests for the `resolveJid` helper
 * and its three call sites in `bootBaileys`:
 *   - `messages.upsert`        (lines ~391–517)
 *   - `messaging-history.set`  (lines ~560–630)
 *   - `messages.reaction`      (lines ~671–694)
 *
 * Why this file exists: Baileys 7.0.0-rc10 surfaces inbound senders as `@lid`
 * JIDs for accounts that have migrated to the LID address book. Without
 * translation the rest of the pipeline, which assumes `@s.whatsapp.net` PN
 * form, silently drops or misidentifies the sender. `resolveJid` translates
 * at the ingress boundary; this suite locks in that contract.
 *
 * Strategy
 * ---------
 * 1. Mock `makeWASocket` to return a controllable stub whose `ev.on(name, fn)`
 *    stores handlers in a Map so tests can fire them synchronously.
 * 2. Give the stub a `signalRepository.lidMapping.getPNForLID` vi.fn() that
 *    tests override per-case via `mockResolvedValueOnce`.
 * 3. Call `(rt as any).bootBaileys()` to bind the listeners without going
 *    through `start()` (which starts timers and fetches session config).
 * 4. Fire events by invoking the captured handler directly, deterministic,
 *    no timers, no polling.
 *
 * Mocked boundaries
 * -----------------
 *   - ioredis, no TCP/TLS on construction
 *   - GatewayClient, callback() observed but never hits HTTP
 *   - @whiskeysockets/baileys, makeWASocket returns a fake sock
 *   - keychain + auth-state, no filesystem access
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- module mocks -----------------------------------------------------------

vi.mock('ioredis', () => {
  const MockRedis = vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    subscribe: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    publish: vi.fn().mockResolvedValue(1),
    set: vi.fn().mockResolvedValue('OK'),
  }));
  (MockRedis as any).default = MockRedis;
  return { default: MockRedis, Redis: MockRedis };
});

const mockCallback = vi.fn().mockResolvedValue(undefined);
vi.mock('../gateway-client.js', () => ({
  GatewayClient: vi.fn().mockImplementation(() => ({
    getSessions: vi.fn().mockResolvedValue({ sessions: [] }),
    callback: mockCallback,
    verifyInbound: vi.fn().mockReturnValue(true),
    getSessionConfig: vi.fn().mockResolvedValue({ sendReadReceipts: true }),
  })),
}));

// The lidMapping mock, each test overrides getPNForLID as needed.
const mockGetPNForLID = vi.fn();

// ev.on handler map, bootBaileys attaches all listeners; tests fire them.
const evHandlers = new Map<string, (...args: any[]) => any>();

vi.mock('@whiskeysockets/baileys', () => ({
  makeWASocket: vi.fn().mockImplementation(() => ({
    ev: {
      on: vi.fn().mockImplementation((name: string, fn: (...args: any[]) => any) => {
        evHandlers.set(name, fn);
      }),
    },
    signalRepository: {
      lidMapping: {
        getPNForLID: mockGetPNForLID,
      },
    },
    // Outbound helpers, only `sendMessage` + `relayMessage` are needed for
    // the outbound regression guard (case 7).
    sendMessage: vi.fn().mockResolvedValue({ key: { id: 'wa-echo-id' } }),
    relayMessage: vi.fn().mockResolvedValue('relay-id'),
    readMessages: vi.fn().mockResolvedValue(undefined),
    logout: vi.fn().mockResolvedValue(undefined),
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
  // Returning null so the messaging-history.set gate (`encKey && firstPairCompletedAt`)
  // does not short-circuit, both must be truthy to skip processing.
  getFirstPairCompletedAt: vi.fn().mockReturnValue(null),
  setFirstPairCompletedAt: vi.fn(),
}));

// ---- imports after mocks ----------------------------------------------------

import { BaileysRuntime } from '../baileys-runtime.js';
import type { WorkerConfig } from '../config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
    'test-session',
    WIRE_SECRET,
    { onStatusChange: vi.fn(), onQr: vi.fn() },
    vi.fn(),
  );
}

/**
 * Build a runtime and boot Baileys (binding all ev.on handlers) without
 * starting the heartbeat / config-refresh timers that `start()` kicks off.
 */
async function buildBootedRuntime(): Promise<BaileysRuntime> {
  const rt = buildRuntime();
  await (rt as any).bootBaileys();
  return rt;
}

/** Fire a `messages.upsert` event with a single message. */
async function fireUpsert(message: Record<string, unknown>): Promise<void> {
  const handler = evHandlers.get('messages.upsert');
  if (!handler) throw new Error('messages.upsert handler not registered');
  await handler({ messages: [message] });
}

/** Fire a `messaging-history.set` event. */
async function fireHistorySet(payload: Record<string, unknown>): Promise<void> {
  const handler = evHandlers.get('messaging-history.set');
  if (!handler) throw new Error('messaging-history.set handler not registered');
  await handler(payload);
}

/** Fire a `messages.reaction` event with a single reaction. */
async function fireReaction(reaction: Record<string, unknown>): Promise<void> {
  const handler = evHandlers.get('messages.reaction');
  if (!handler) throw new Error('messages.reaction handler not registered');
  await handler([reaction]);
}

/** Minimal inbound DM message, only the fields the upsert handler reads. */
function makeMsg(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: {
      id: 'wa-msg-test-id',
      remoteJid: '447700900123@s.whatsapp.net',
      fromMe: false,
    },
    message: { conversation: 'hello' },
    messageTimestamp: 1_700_000_000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  evHandlers.clear();
  mockGetPNForLID.mockReset();
});

// ===========================================================================
// messages.upsert
// ===========================================================================

describe('messages.upsert, LID sender with mapping present', () => {
  it('translates @lid remoteJid to @s.whatsapp.net before emitting chat_event', async () => {
    mockGetPNForLID.mockResolvedValueOnce('447700900123@s.whatsapp.net');
    await buildBootedRuntime();

    await fireUpsert(
      makeMsg({
        key: {
          id: 'wa-msg-lid-present',
          remoteJid: '217716287885318:74@lid',
          fromMe: true, // fromMe so the chat_event path runs (Case A)
        },
      }),
    );

    // The chat_event callback should carry the translated PN JID.
    expect(mockCallback).toHaveBeenCalledOnce();
    const envelope = mockCallback.mock.calls[0]![0] as Record<string, unknown>;
    expect(envelope.kind).toBe('chat_event');
    expect(envelope.counterpartyJid).toBe('447700900123@s.whatsapp.net');
    expect(envelope.counterpartyE164).toBe('+447700900123');

    // The mapping must have been consulted exactly once.
    expect(mockGetPNForLID).toHaveBeenCalledOnce();
    expect(mockGetPNForLID).toHaveBeenCalledWith('217716287885318:74@lid');
  });
});

describe('messages.upsert, LID sender, mapping returns null (soft-fail)', () => {
  it('emits the event unchanged with counterpartyE164 null when LID is unresolved', async () => {
    // Stub a logger so we can assert on the warn call.
    mockGetPNForLID.mockResolvedValueOnce(null);
    const rt = buildRuntime();
    const mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: vi.fn().mockReturnThis(),
    };
    (rt as any).logger = mockLogger;
    await (rt as any).bootBaileys();

    await fireUpsert(
      makeMsg({
        key: {
          id: 'wa-msg-lid-null',
          remoteJid: '217716287885318:74@lid',
          fromMe: true, // fromMe so chat_event path runs (Case A)
        },
      }),
    );

    // Event must be emitted, soft-fail means no drop.
    expect(mockCallback).toHaveBeenCalledOnce();
    const envelope = mockCallback.mock.calls[0]![0] as Record<string, unknown>;
    expect(envelope.kind).toBe('chat_event');
    // JID is unchanged when mapping is null.
    expect(envelope.counterpartyJid).toBe('217716287885318:74@lid');
    // jidToE164 returns null for non-@s.whatsapp.net JIDs.
    expect(envelope.counterpartyE164).toBeNull();

    // A warn must have been emitted with the expected literal.
    const warnCalls = mockLogger.warn.mock.calls as Array<[Record<string, unknown>, string]>;
    const lidWarn = warnCalls.find(([, msg]) => msg === 'lid mapping unresolved');
    expect(lidWarn).toBeDefined();
  });
});

describe('messages.upsert, plain PN sender (no @lid)', () => {
  it('passes through @s.whatsapp.net JID unchanged without calling getPNForLID', async () => {
    await buildBootedRuntime();

    await fireUpsert(
      makeMsg({
        key: {
          id: 'wa-msg-pn',
          remoteJid: '447700900123@s.whatsapp.net',
          fromMe: true,
        },
      }),
    );

    // getPNForLID must never be called for a plain PN JID.
    expect(mockGetPNForLID).not.toHaveBeenCalled();

    // The JID is forwarded as-is.
    expect(mockCallback).toHaveBeenCalledOnce();
    const envelope = mockCallback.mock.calls[0]![0] as Record<string, unknown>;
    expect(envelope.counterpartyJid).toBe('447700900123@s.whatsapp.net');
    expect(envelope.counterpartyE164).toBe('+447700900123');
  });
});

describe('messages.upsert, group sender (@g.us)', () => {
  it('emits a group chat_event without calling getPNForLID', async () => {
    await buildBootedRuntime();

    await fireUpsert(
      makeMsg({
        key: {
          id: 'wa-msg-group',
          remoteJid: '120363042000000001@g.us',
          fromMe: false,
        },
      }),
    );

    // Groups never consult the LID mapping.
    expect(mockGetPNForLID).not.toHaveBeenCalled();

    // The group path emits a chat_event (Case B) with counterpartyE164 null.
    expect(mockCallback).toHaveBeenCalledOnce();
    const envelope = mockCallback.mock.calls[0]![0] as Record<string, unknown>;
    expect(envelope.kind).toBe('chat_event');
    expect(envelope.counterpartyJid).toBe('120363042000000001@g.us');
    expect(envelope.counterpartyE164).toBeNull();
  });
});

// ===========================================================================
// messaging-history.set
// ===========================================================================

describe('messaging-history.set, LID sender in history payload, mapping present', () => {
  it('translates @lid remoteJid and enqueues history row with resolved counterpartyE164', async () => {
    mockGetPNForLID.mockResolvedValueOnce('447700900123@s.whatsapp.net');
    const rt = await buildBootedRuntime();

    await fireHistorySet({
      messages: [
        {
          key: { id: 'hist-msg-lid-present', remoteJid: '217716287885318:74@lid', fromMe: false },
          message: { conversation: 'hi from history' },
          messageTimestamp: 1_700_000_000,
        },
      ],
      contacts: [],
      isLatest: false,
    });

    // Assert directly on historyBuffer, no timer needed; one row should be queued.
    const buf = (rt as any).historyBuffer as Array<Record<string, unknown>>;
    expect(buf).toHaveLength(1);
    expect(buf[0]!.counterpartyJid).toBe('447700900123@s.whatsapp.net');
    expect(buf[0]!.counterpartyE164).toBe('+447700900123');
    expect(buf[0]!.direction).toBe('in_history');

    expect(mockGetPNForLID).toHaveBeenCalledOnce();
    expect(mockGetPNForLID).toHaveBeenCalledWith('217716287885318:74@lid');
  });
});

describe('messaging-history.set, LID sender, mapping returns null (soft-fail)', () => {
  it('still enqueues the history row with counterpartyE164 null when LID is unresolved', async () => {
    mockGetPNForLID.mockResolvedValueOnce(null);
    const rt = await buildBootedRuntime();

    await fireHistorySet({
      messages: [
        {
          key: { id: 'hist-msg-lid-null', remoteJid: '217716287885318:74@lid', fromMe: false },
          message: { conversation: 'hi from unresolved history' },
          messageTimestamp: 1_700_000_000,
        },
      ],
      contacts: [],
      isLatest: false,
    });

    const buf = (rt as any).historyBuffer as Array<Record<string, unknown>>;
    expect(buf).toHaveLength(1);
    // JID falls back to original when mapping is null.
    expect(buf[0]!.counterpartyJid).toBe('217716287885318:74@lid');
    // jidToE164 returns null for @lid, matches pre-v7 unresolvable behaviour.
    expect(buf[0]!.counterpartyE164).toBeNull();
  });
});

// ===========================================================================
// messages.reaction
// ===========================================================================

describe('messages.reaction, LID reactor', () => {
  it('translates @lid reactor JID before forwarding the reaction callback', async () => {
    mockGetPNForLID.mockResolvedValueOnce('447700900123@s.whatsapp.net');
    await buildBootedRuntime();

    await fireReaction({
      key: { remoteJid: '217716287885318:74@lid', fromMe: false, id: 'reaction-wrapper-id' },
      reaction: {
        key: { remoteJid: '447700900123@s.whatsapp.net', id: 'target-msg-id', fromMe: true },
        text: '\u{1F44D}',
      },
    });

    expect(mockCallback).toHaveBeenCalledOnce();
    const envelope = mockCallback.mock.calls[0]![0] as Record<string, unknown>;
    expect(envelope.kind).toBe('reaction');
    // fromJid must be the translated PN form.
    expect(envelope.fromJid).toBe('447700900123@s.whatsapp.net');
    // from is the E.164 derived from the PN JID.
    expect(envelope.from).toBe('+447700900123');

    expect(mockGetPNForLID).toHaveBeenCalledOnce();
    expect(mockGetPNForLID).toHaveBeenCalledWith('217716287885318:74@lid');
  });
});

// ===========================================================================
// Outbound regression guard
// ===========================================================================

describe('handleSend, outbound path never consults the LID mapping', () => {
  it('sends to PN JID without calling getPNForLID', async () => {
    // Direct stub injection, same pattern as handle-send-ephemeral.test.ts.
    const rt = buildRuntime();
    const sockStub = {
      sendMessage: vi.fn().mockResolvedValue({ key: { id: 'wa-sent-id' } }),
      relayMessage: vi.fn().mockResolvedValue('relay-id'),
      signalRepository: {
        lidMapping: { getPNForLID: mockGetPNForLID },
      },
    };
    (rt as any).sock = sockStub;
    (rt as any).logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

    await (rt as any).handleSend({
      kind: 'send',
      messageId: '00000000-0000-4000-8000-000000000001',
      to: '+447700900123',
      body: { kind: 'text', text: 'Hello' },
      channel: 'transactional',
      projectId: 'acme',
      purpose: 'otp',
      apiKeyId: 'key_abc',
      requestId: 'req-test',
      nonce: '00000000-0000-4000-8000-000000000002',
      at: new Date().toISOString(),
      sig: 'a'.repeat(64),
    });

    // The outbound path constructs the JID from `env.to` via `toJid()`, it
    // never touches the LID mapping. A "helpful" extension here would break
    // the PN-by-construction contract.
    expect(mockGetPNForLID).not.toHaveBeenCalled();
    expect(sockStub.sendMessage).toHaveBeenCalledOnce();
  });
});

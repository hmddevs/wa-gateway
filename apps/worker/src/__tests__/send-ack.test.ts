/**
 * BaileysRuntime.handleSend, wa:ack publish behaviour.
 *
 * Mocked boundaries:
 *   - ioredis, prevents real TCP connections
 *   - gateway callback, prevents network calls out to gateway
 *   - sock.sendMessage, replaced with controlled stubs per test
 *
 * Invocation: `(runtime as any).handleSend(env)` (private method).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BaileysRuntime } from '../baileys-runtime.js';
import { SendAckEnvelopeSchema } from '@hmddevs/protocol/wire';
import type { WorkerConfig } from '../config.js';

// ---- module mock: ioredis ---------------------------------------------------
// Prevents BaileysRuntime constructor from opening TCP connections.

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

// ---- helpers ----------------------------------------------------------------

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

/** Wire envelope for a simple text send. */
function makeSendEnv(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    kind: 'send',
    messageId: '00000000-0000-4000-8000-000000000001',
    to: '+447700900123',
    body: { kind: 'text', text: 'Hello test' },
    channel: 'transactional',
    apiKeyId: 'key_abc',
    requestId: 'req-test-001',
    nonce: 'nonce-test',
    at: new Date().toISOString(),
    sig: 'test-sig',
    ...overrides,
  };
}

/** Minimal stub for pino logger. */
function makeLogger() {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  };
  // child() must return an object compatible with pino.Logger
  logger.child.mockReturnValue(logger);
  return logger;
}

function buildRuntime() {
  const runtime = new BaileysRuntime(
    MINIMAL_CONFIG,
    'session-test',
    WIRE_SECRET,
    {
      onStatusChange: vi.fn(),
      onQr: vi.fn(),
    },
    vi.fn(),
  );

  // Stub pino logger to a silent mock so logs don't pollute test output.
  const mockLogger = makeLogger();
  (runtime as any).logger = mockLogger;

  // Stub gateway, prevent any real HTTP call.
  const mockGateway = {
    callback: vi.fn().mockResolvedValue(undefined),
    batchCallback: vi.fn().mockResolvedValue(undefined),
    verifyInbound: vi.fn().mockReturnValue(true),
    getSessionConfig: vi.fn().mockResolvedValue({ sendReadReceipts: true }),
  };
  (runtime as any).gateway = mockGateway;

  // Expose the internal redis ops client for spy access.
  const mockRedisOps = (runtime as any).redisOps as {
    publish: ReturnType<typeof vi.fn>;
    set: ReturnType<typeof vi.fn>;
    lrem: ReturnType<typeof vi.fn>;
  };

  return { runtime, mockGateway, mockLogger, mockRedisOps };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleSend wa:ack publish', () => {
  let runtime: BaileysRuntime;
  let mockGateway: ReturnType<typeof buildRuntime>['mockGateway'];
  let mockLogger: ReturnType<typeof makeLogger>;
  let mockRedisOps: ReturnType<typeof buildRuntime>['mockRedisOps'];

  beforeEach(() => {
    vi.clearAllMocks();
    ({ runtime, mockGateway, mockLogger, mockRedisOps } = buildRuntime());
  });

  it('success path publishes status: sent with waMessageId on wa:ack:<messageId>', async () => {
    const waMessageId = 'wamid.SUCCESS01';
    const env = makeSendEnv();

    // Stub Baileys sock, sendMessage resolves with key.id
    (runtime as any).sock = {
      sendMessage: vi.fn().mockResolvedValue({ key: { id: waMessageId } }),
    };

    await (runtime as any).handleSend(env);

    // gateway.callback should have been called with ok: true
    expect(mockGateway.callback).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'send_ack', ok: true, waMessageId }),
    );

    // redisOps.publish must be called once on the ack channel
    expect(mockRedisOps.publish).toHaveBeenCalledOnce();
    const [channel, payloadStr] = mockRedisOps.publish.mock.calls[0] as [string, string];
    expect(channel).toBe(`wa:ack:${env.messageId}`);

    const payload = JSON.parse(payloadStr);
    const parsed = SendAckEnvelopeSchema.safeParse(payload);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.status).toBe('sent');
      expect(parsed.data.waMessageId).toBe(waMessageId);
    }

    // why: gateway-route reads MessageDoc.status after the callback commits;
    // a follow-up GET racing the ack must see the DB update first.
    const callbackOrder = mockGateway.callback.mock.invocationCallOrder[0];
    const publishOrder = mockRedisOps.publish.mock.invocationCallOrder[0];
    expect(callbackOrder).toBeDefined();
    expect(publishOrder).toBeDefined();
    expect(callbackOrder!).toBeLessThan(publishOrder!);
  });

  it('failure path publishes status: failed with errorCode SEND_FAILED', async () => {
    const env = makeSendEnv();

    // Stub Baileys sock, sendMessage rejects
    (runtime as any).sock = {
      sendMessage: vi.fn().mockRejectedValue(new Error('Baileys timeout')),
    };

    await (runtime as any).handleSend(env);

    // gateway.callback called with ok: false
    expect(mockGateway.callback).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'send_ack', ok: false }),
    );

    // ack publish called on correct channel with failed status
    expect(mockRedisOps.publish).toHaveBeenCalled();
    const [channel, payloadStr] = mockRedisOps.publish.mock.calls[0] as [string, string];
    expect(channel).toBe(`wa:ack:${env.messageId}`);

    const payload = JSON.parse(payloadStr);
    const parsed = SendAckEnvelopeSchema.safeParse(payload);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.status).toBe('failed');
      expect(parsed.data.errorCode).toBe('SEND_FAILED');
    }

    const callbackOrder = mockGateway.callback.mock.invocationCallOrder[0];
    const publishOrder = mockRedisOps.publish.mock.invocationCallOrder[0];
    expect(callbackOrder).toBeDefined();
    expect(publishOrder).toBeDefined();
    expect(callbackOrder!).toBeLessThan(publishOrder!);
  });

  it('publish failure does NOT throw: handleSend resolves cleanly and logs a warning', async () => {
    const env = makeSendEnv();

    (runtime as any).sock = {
      sendMessage: vi.fn().mockResolvedValue({ key: { id: 'wamid.PUB_FAIL' } }),
    };

    // Make publish reject, simulates Redis being unreachable
    mockRedisOps.publish.mockRejectedValue(new Error('Redis connection refused'));

    // Must not throw
    await expect((runtime as any).handleSend(env)).resolves.toBeUndefined();

    // A warn log should have been issued with the publish failure detail
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(String) }),
      expect.stringContaining('wa:ack publish failed'),
    );
  });
});

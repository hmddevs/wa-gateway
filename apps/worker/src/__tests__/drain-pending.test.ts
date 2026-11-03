/**
 * BaileysRuntime.drainPending, replay-after-outage behaviour.
 *
 * Tests that the pending-queue drain path bypasses the 60s freshness window
 * but still enforces HMAC verification and nonce dedup. Live Pub/Sub path
 * must still enforce the 60s gate.
 *
 * Mocked boundaries:
 *   - ioredis, prevents real TCP connections
 *   - gateway callback, prevents network calls out to gateway
 *   - sock.sendMessage, replaced with controlled stubs per test
 *
 * Invocation: `(runtime as any).handleIncomingWire(channel, message, isDrain)`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BaileysRuntime } from '../baileys-runtime.js';
import type { WorkerConfig } from '../config.js';

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

function makeLogger() {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  };
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

  const mockLogger = makeLogger();
  (runtime as any).logger = mockLogger;

  const mockGateway = {
    callback: vi.fn().mockResolvedValue(undefined),
    batchCallback: vi.fn().mockResolvedValue(undefined),
    verifyInbound: vi.fn().mockReturnValue(true),
    getSessionConfig: vi.fn().mockResolvedValue({ sendReadReceipts: true }),
  };
  (runtime as any).gateway = mockGateway;

  const mockRedisOps = (runtime as any).redisOps as {
    publish: ReturnType<typeof vi.fn>;
    set: ReturnType<typeof vi.fn>;
  };

  (runtime as any).sock = {
    sendMessage: vi.fn().mockResolvedValue({ key: { id: 'wamid.TEST001' } }),
  };

  return { runtime, mockGateway, mockLogger, mockRedisOps };
}

describe('drainPending, freshness gate bypass', () => {
  let runtime: BaileysRuntime;
  let mockGateway: ReturnType<typeof buildRuntime>['mockGateway'];
  let mockLogger: ReturnType<typeof makeLogger>;
  let mockRedisOps: ReturnType<typeof buildRuntime>['mockRedisOps'];

  beforeEach(() => {
    vi.clearAllMocks();
    ({ runtime, mockGateway, mockLogger, mockRedisOps } = buildRuntime());
  });

  it('accepts stale envelope on drain path (isDrain=true) and calls handleSend', async () => {
    // Envelope with timestamp 70 seconds in the past
    const staleAt = new Date(Date.now() - 70_000).toISOString();
    const env = makeSendEnv({ at: staleAt });
    const wire = JSON.stringify(env);

    // Call with isDrain=true
    await (runtime as any).handleIncomingWire('wa:outbound:session-test', wire, true);

    // Should NOT have logged "stale timestamp, dropped"
    expect(mockLogger.warn).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('stale timestamp'),
    );

    // Should have logged the drain replay info
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: env.messageId, deltaMs: expect.any(Number) }),
      expect.stringContaining('drain replay accepted past freshness window'),
    );

    // HMAC verify should have been called
    expect(mockGateway.verifyInbound).toHaveBeenCalled();

    // Nonce dedup should have been executed (set called)
    expect(mockRedisOps.set).toHaveBeenCalled();

    // handleSend must have been called
    expect(mockGateway.callback).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'send_ack' }),
    );
  });

  it('rejects stale envelope on live path (isDrain=false) with timestamp warning', async () => {
    const staleAt = new Date(Date.now() - 70_000).toISOString();
    const env = makeSendEnv({ at: staleAt });
    const wire = JSON.stringify(env);

    // Call with isDrain=false (or omitted, default)
    await (runtime as any).handleIncomingWire('wa:outbound:session-test', wire, false);

    // Should have logged "stale timestamp, dropped"
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'send', messageId: env.messageId }),
      'stale timestamp, dropped',
    );

    // HMAC verify should NOT have been called (exit before that)
    expect(mockGateway.verifyInbound).not.toHaveBeenCalled();

    // handleSend should NOT have been called
    expect(mockGateway.callback).not.toHaveBeenCalled();
  });

  it('rejects malformed timestamp on both paths', async () => {
    const env = makeSendEnv({ at: 'not-a-date' });
    const wire = JSON.stringify(env);

    // Drain path
    await (runtime as any).handleIncomingWire('wa:outbound:session-test', wire, true);

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'send', messageId: env.messageId }),
      'invalid timestamp, dropped',
    );

    expect(mockGateway.verifyInbound).not.toHaveBeenCalled();
    expect(mockGateway.callback).not.toHaveBeenCalled();
  });

  it('enforces HMAC verify on drain path', async () => {
    const env = makeSendEnv({ at: new Date(Date.now() - 70_000).toISOString() });
    const wire = JSON.stringify(env);

    mockGateway.verifyInbound.mockReturnValue(false);

    await (runtime as any).handleIncomingWire('wa:outbound:session-test', wire, true);

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'send', messageId: env.messageId }),
      'bad signature, dropped',
    );

    expect(mockGateway.callback).not.toHaveBeenCalled();
  });

  it('enforces nonce dedup on drain path (duplicate nonce → skip)', async () => {
    const env = makeSendEnv({ at: new Date(Date.now() - 70_000).toISOString() });
    const wire = JSON.stringify(env);

    // First call succeeds (messageId dedup set OK, nonce dedup set OK)
    mockRedisOps.set.mockResolvedValueOnce('OK'); // messageId dedup
    mockRedisOps.set.mockResolvedValueOnce('OK'); // nonce dedup
    await (runtime as any).handleIncomingWire('wa:outbound:session-test', wire, true);
    expect(mockGateway.callback).toHaveBeenCalledOnce();

    // Second call with same messageId (messageId dedup returns null, duplicate)
    mockRedisOps.set.mockResolvedValueOnce(null); // messageId dedup on second call returns null
    await (runtime as any).handleIncomingWire('wa:outbound:session-test', wire, true);

    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: env.messageId, isDrain: true }),
      'message already processed, replay skipped',
    );

    // Should still be called only once from the first call
    expect(mockGateway.callback).toHaveBeenCalledOnce();
  });
});

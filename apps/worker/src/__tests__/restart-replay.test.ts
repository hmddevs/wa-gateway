/**
 * Regression test for P0 worker-restart message-replay bug (#65).
 *
 * Simulates the exact failure mode: gateway dual-writes to both Redis list
 * (persisted) and pub/sub (real-time). Worker drains the list on startup,
 * and previously would replay every message ever sent because:
 * - The 24h list TTL refreshes on every push and never expires on a live system
 * - The 60s stale-timestamp gate was removed for drain in PR #65
 * - No dedup protection existed on restart
 *
 * Fix (now in place):
 * 1. handleIncomingWire does SET-NX on wa:msg-processed:<sessionId>:<messageId> (7d TTL)
 * 2. handleSend / handleReact fire-and-forget LREM after successful send
 * 3. Gateway lpush bounds list at 1000 entries
 *
 * Mocked boundaries:
 *   - ioredis, prevents real TCP connections
 *   - gateway callback, prevents network calls out to gateway
 *   - sock.sendMessage, replaced with controlled stubs per test
 *   - redisOps SET-NX / LREM calls tracked via vi.fn()
 *
 * Test scenarios:
 * 1. Healthy operation, pub/sub-only path, list stays clean
 * 2. Restart-replay simulation, drain finds old list, dedup blocks all replays
 * 3. Mixed, 2 unprocessed + 3 processed in the list
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

function makeReactEnv(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    kind: 'react',
    messageId: '00000000-0000-4000-8000-000000000002',
    waJid: '447700900123@s.whatsapp.net',
    targetWaMessageId: 'wamid.PREV001',
    targetFromMe: true,
    emoji: '👍',
    projectId: 'proj_test',
    nonce: 'nonce-react-test',
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
    rpop: ReturnType<typeof vi.fn>;
    lrem: ReturnType<typeof vi.fn>;
  };

  (runtime as any).sock = {
    sendMessage: vi.fn().mockResolvedValue({ key: { id: 'wamid.TEST001' } }),
  };

  return { runtime, mockGateway, mockLogger, mockRedisOps };
}

// ---- tests ------------------------------------------------------------------

describe('restart-replay, P0 regression', () => {
  let runtime: BaileysRuntime;
  let mockLogger: ReturnType<typeof makeLogger>;
  let mockRedisOps: ReturnType<typeof buildRuntime>['mockRedisOps'];

  beforeEach(() => {
    vi.clearAllMocks();
    ({ runtime, mockLogger, mockRedisOps } = buildRuntime());
  });

  describe('scenario 1: healthy operation, pub/sub-only path', () => {
    it('processes 3 pub/sub messages without replay, marks each as processed, removes from pending', async () => {
      // Setup: drainPending finds empty list on startup
      mockRedisOps.rpop.mockResolvedValueOnce(null);

      // Invoke drainPending
      await (runtime as any).drainPending();

      // Drain found nothing
      expect(mockRedisOps.rpop).toHaveBeenCalledWith('wa:pending:session-test');

      // Simulate 3 messages arriving over pub/sub
      const msgIds = ['msg-1', 'msg-2', 'msg-3'];
      const waMessageIds = ['wamid.001', 'wamid.002', 'wamid.003'];

      for (let i = 0; i < 3; i++) {
        const env = makeSendEnv({
          messageId: msgIds[i],
          nonce: `nonce-${i}`,
        });
        const wire = JSON.stringify(env);

        // Mock successful send
        (runtime as any).sock.sendMessage.mockResolvedValueOnce({
          key: { id: waMessageIds[i] },
        });

        // Process the wire (pub/sub path, isDrain=false)
        await (runtime as any).handleIncomingWire('wa:outbound:session-test', wire, false);
      }

      // Assert: sock.sendMessage called exactly 3 times (once per messageId)
      expect((runtime as any).sock.sendMessage).toHaveBeenCalledTimes(3);

      // Assert: wa:msg-processed:* keys exist for all 3 messageIds
      // (via SET with EX/NX semantics)
      expect(mockRedisOps.set).toHaveBeenCalledWith(
        'wa:msg-processed:session-test:msg-1',
        '1',
        'EX',
        604800,
        'NX',
      );
      expect(mockRedisOps.set).toHaveBeenCalledWith(
        'wa:msg-processed:session-test:msg-2',
        '1',
        'EX',
        604800,
        'NX',
      );
      expect(mockRedisOps.set).toHaveBeenCalledWith(
        'wa:msg-processed:session-test:msg-3',
        '1',
        'EX',
        604800,
        'NX',
      );

      // Assert: lrem called for each successfully sent wire
      expect(mockRedisOps.lrem).toHaveBeenCalledTimes(3);
    });
  });

  describe('scenario 2: restart-replay, drain blocks all pre-processed messages', () => {
    it('finds 5 old messages in pending list, all with dedup keys set, skips all 5', async () => {
      // Pre-populate pending list with 5 wires that have ALREADY been processed
      const wires = [
        JSON.stringify(makeSendEnv({ messageId: 'old-1', nonce: 'nonce-old-1' })),
        JSON.stringify(makeSendEnv({ messageId: 'old-2', nonce: 'nonce-old-2' })),
        JSON.stringify(makeSendEnv({ messageId: 'old-3', nonce: 'nonce-old-3' })),
        JSON.stringify(makeSendEnv({ messageId: 'old-4', nonce: 'nonce-old-4' })),
        JSON.stringify(makeSendEnv({ messageId: 'old-5', nonce: 'nonce-old-5' })),
      ];

      // Mock rpop to return the 5 wires in sequence, then null to end the drain
      mockRedisOps.rpop
        .mockResolvedValueOnce(wires[0])
        .mockResolvedValueOnce(wires[1])
        .mockResolvedValueOnce(wires[2])
        .mockResolvedValueOnce(wires[3])
        .mockResolvedValueOnce(wires[4])
        .mockResolvedValueOnce(null);

      // Mark all 5 messageIds as already processed (SET-NX returns null on duplicate,
      // causing early exit before nonce dedup)
      mockRedisOps.set
        .mockResolvedValueOnce(null) // old-1 messageId dedup exists → skip nonce dedup
        .mockResolvedValueOnce(null) // old-2 messageId dedup exists → skip nonce dedup
        .mockResolvedValueOnce(null) // old-3 messageId dedup exists → skip nonce dedup
        .mockResolvedValueOnce(null) // old-4 messageId dedup exists → skip nonce dedup
        .mockResolvedValueOnce(null); // old-5 messageId dedup exists → skip nonce dedup

      // Invoke drainPending
      await (runtime as any).drainPending();

      // Assert: sock.sendMessage called 0 times (all blocked by dedup)
      expect((runtime as any).sock.sendMessage).not.toHaveBeenCalled();

      // Assert: each replay logs "message already processed, replay skipped"
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ messageId: 'old-1', isDrain: true }),
        'message already processed, replay skipped',
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ messageId: 'old-2', isDrain: true }),
        'message already processed, replay skipped',
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ messageId: 'old-3', isDrain: true }),
        'message already processed, replay skipped',
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ messageId: 'old-4', isDrain: true }),
        'message already processed, replay skipped',
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ messageId: 'old-5', isDrain: true }),
        'message already processed, replay skipped',
      );
    });
  });

  describe('scenario 3: mixed, 2 unprocessed + 3 pre-processed', () => {
    it('drains 5 wires from list, only 2 fresh ones go through sock.sendMessage', async () => {
      const freshWire1 = JSON.stringify(
        makeSendEnv({ messageId: 'fresh-1', nonce: 'nonce-fresh-1' }),
      );
      const freshWire2 = JSON.stringify(
        makeReactEnv({ messageId: 'fresh-2', nonce: 'nonce-fresh-2' }),
      );
      const oldWire1 = JSON.stringify(makeSendEnv({ messageId: 'old-1', nonce: 'nonce-old-1' }));
      const oldWire2 = JSON.stringify(makeSendEnv({ messageId: 'old-2', nonce: 'nonce-old-2' }));
      const oldWire3 = JSON.stringify(makeSendEnv({ messageId: 'old-3', nonce: 'nonce-old-3' }));

      // Mock rpop to return 5 wires: fresh-1, old-1, fresh-2, old-2, old-3, then null
      mockRedisOps.rpop
        .mockResolvedValueOnce(freshWire1)
        .mockResolvedValueOnce(oldWire1)
        .mockResolvedValueOnce(freshWire2)
        .mockResolvedValueOnce(oldWire2)
        .mockResolvedValueOnce(oldWire3)
        .mockResolvedValueOnce(null);

      // Mock SET-NX: fresh wires succeed ('OK'), old wires already exist (null)
      mockRedisOps.set
        // fresh-1 processing
        .mockResolvedValueOnce('OK') // fresh-1 dedup key set
        .mockResolvedValueOnce('OK') // fresh-1 nonce dedup set
        // old-1 processing
        .mockResolvedValueOnce(null) // old-1 dedup key exists → return null
        // fresh-2 processing
        .mockResolvedValueOnce('OK') // fresh-2 dedup key set
        .mockResolvedValueOnce('OK') // fresh-2 nonce dedup set
        // old-2 processing
        .mockResolvedValueOnce(null) // old-2 dedup key exists → return null
        // old-3 processing
        .mockResolvedValueOnce(null); // old-3 dedup key exists → return null

      // Mock successful sends for fresh wires
      (runtime as any).sock.sendMessage
        .mockResolvedValueOnce({ key: { id: 'wamid.FRESH1' } })
        .mockResolvedValueOnce({ key: { id: 'wamid.FRESH2' } });

      // Invoke drainPending
      await (runtime as any).drainPending();

      // Assert: sock.sendMessage called exactly 2 times (for the 2 fresh messageIds)
      expect((runtime as any).sock.sendMessage).toHaveBeenCalledTimes(2);

      // Assert: the 3 pre-processed messageIds never reach sock.sendMessage
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ messageId: 'old-1', isDrain: true }),
        'message already processed, replay skipped',
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ messageId: 'old-2', isDrain: true }),
        'message already processed, replay skipped',
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ messageId: 'old-3', isDrain: true }),
        'message already processed, replay skipped',
      );

      // Assert: lrem called for the 2 successfully sent wires (fresh ones)
      expect(mockRedisOps.lrem).toHaveBeenCalledWith('wa:pending:session-test', 1, freshWire1);
      expect(mockRedisOps.lrem).toHaveBeenCalledWith('wa:pending:session-test', 1, freshWire2);
      // Old wires never reach lrem (they don't pass dedup)
      expect(mockRedisOps.lrem).toHaveBeenCalledTimes(2);
    });
  });
});

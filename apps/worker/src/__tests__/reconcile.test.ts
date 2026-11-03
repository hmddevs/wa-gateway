/**
 * SessionManager.reconcile, drift detection between worker runtimes and the
 * gateway's authoritative session list.
 *
 * Covers the missed-control-message gap (e.g., a `stop_session` envelope lost
 * in transit leaves an orphan runtime). Triggered every 5 min in production;
 * exposed via the public `reconcile()` method so tests can drive it directly.
 *
 * Mocked boundaries:
 *   - ioredis, prevents real TCP / TLS handshake on construction
 *   - GatewayClient, controls the session-list response per test
 *   - BaileysRuntime, start()/stop() observed but never boots Baileys
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionManager } from '../session-manager.js';
import type { WorkerConfig } from '../config.js';

vi.mock('ioredis', () => {
  const MockRedis = vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    subscribe: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    publish: vi.fn().mockResolvedValue(1),
  }));
  (MockRedis as any).default = MockRedis;
  return { default: MockRedis, Redis: MockRedis };
});

const mockGetSessions = vi.fn();
vi.mock('../gateway-client.js', () => ({
  GatewayClient: vi.fn().mockImplementation(() => ({
    getSessions: mockGetSessions,
    callback: vi.fn().mockResolvedValue(undefined),
    verifyInbound: vi.fn().mockReturnValue(true),
  })),
}));

const mockRuntimeStart = vi.fn().mockResolvedValue(undefined);
const mockRuntimeStop = vi.fn().mockResolvedValue(undefined);
vi.mock('../baileys-runtime.js', () => ({
  BaileysRuntime: vi.fn().mockImplementation(() => ({
    start: mockRuntimeStart,
    stop: mockRuntimeStop,
    sendShutdownBeacon: vi.fn().mockResolvedValue(undefined),
    get currentStatus() {
      return 'connected';
    },
    get pairedPhone() {
      return null;
    },
    get latestQr() {
      return null;
    },
  })),
}));

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

function buildManager(): SessionManager {
  return new SessionManager(MINIMAL_CONFIG, WIRE_SECRET, vi.fn());
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('SessionManager.reconcile', () => {
  it('starts sessions the gateway lists but the worker is missing', async () => {
    const mgr = buildManager();
    mockGetSessions.mockResolvedValueOnce({ sessions: [{ sessionId: 'acme' }] });

    const result = await mgr.reconcile();

    expect(result).toMatchObject({ started: 1, stopped: 0, gatewaySize: 1 });
    expect(mockRuntimeStart).toHaveBeenCalledOnce();
    expect(mockRuntimeStop).not.toHaveBeenCalled();
  });

  it('stops sessions the worker has but the gateway no longer lists', async () => {
    const mgr = buildManager();

    // Seed: worker thinks it owns `acme` and `other-session`.
    mockGetSessions.mockResolvedValueOnce({
      sessions: [{ sessionId: 'acme' }, { sessionId: 'other-session' }],
    });
    await mgr.reconcile();
    expect(mockRuntimeStart).toHaveBeenCalledTimes(2);
    mockRuntimeStart.mockClear();

    // Gateway forgot `other-session` (e.g., admin DELETE missed a stop_session message).
    mockGetSessions.mockResolvedValueOnce({ sessions: [{ sessionId: 'acme' }] });
    const result = await mgr.reconcile();

    expect(result).toMatchObject({ started: 0, stopped: 1, gatewaySize: 1 });
    expect(mockRuntimeStop).toHaveBeenCalledOnce();
    expect(mockRuntimeStart).not.toHaveBeenCalled();
  });

  it('is a no-op when worker and gateway agree', async () => {
    const mgr = buildManager();

    // Seed.
    mockGetSessions.mockResolvedValueOnce({ sessions: [{ sessionId: 'acme' }] });
    await mgr.reconcile();
    mockRuntimeStart.mockClear();
    mockRuntimeStop.mockClear();

    // Same list a tick later.
    mockGetSessions.mockResolvedValueOnce({ sessions: [{ sessionId: 'acme' }] });
    const result = await mgr.reconcile();

    expect(result).toMatchObject({ started: 0, stopped: 0, gatewaySize: 1 });
    expect(mockRuntimeStart).not.toHaveBeenCalled();
    expect(mockRuntimeStop).not.toHaveBeenCalled();
  });

  it('handles the simultaneous start-some / stop-some case', async () => {
    const mgr = buildManager();

    // Seed: worker has [a, b].
    mockGetSessions.mockResolvedValueOnce({
      sessions: [{ sessionId: 'a' }, { sessionId: 'b' }],
    });
    await mgr.reconcile();
    mockRuntimeStart.mockClear();

    // Gateway now lists [b, c]: drop a, add c.
    mockGetSessions.mockResolvedValueOnce({
      sessions: [{ sessionId: 'b' }, { sessionId: 'c' }],
    });
    const result = await mgr.reconcile();

    expect(result).toMatchObject({ started: 1, stopped: 1, gatewaySize: 2 });
    expect(mockRuntimeStart).toHaveBeenCalledOnce();
    expect(mockRuntimeStop).toHaveBeenCalledOnce();
  });

  it('propagates getSessions failure (caller decides retry / log policy)', async () => {
    const mgr = buildManager();
    mockGetSessions.mockRejectedValueOnce(new Error('gateway 502'));

    await expect(mgr.reconcile()).rejects.toThrow('gateway 502');
    expect(mockRuntimeStart).not.toHaveBeenCalled();
    expect(mockRuntimeStop).not.toHaveBeenCalled();
  });
});

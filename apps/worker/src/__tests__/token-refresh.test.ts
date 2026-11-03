/**
 * SessionManager proactive token rotation.
 *
 * Regression for the 2026-06-24 lockout: the 30-day refresh JWT was only ever
 * rotated reactively on a 401, but in steady state callbacks succeed, so the
 * token silently aged out and the worker locked itself out of the gateway
 * (every callback + heartbeat 401, messages stuck `queued`, worker shown
 * offline). SessionManager now rotates once at startup and every 12h so the
 * token never reaches its expiry cliff.
 *
 * Mocked boundaries mirror reconcile.test.ts; the GatewayClient mock adds
 * `rotateToken` so the rotation cadence can be observed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SessionManager, TOKEN_REFRESH_INTERVAL_MS } from '../session-manager.js';
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
const mockRotateToken = vi.fn();
vi.mock('../gateway-client.js', () => ({
  GatewayClient: vi.fn().mockImplementation(() => ({
    getSessions: mockGetSessions,
    rotateToken: mockRotateToken,
    callback: vi.fn().mockResolvedValue(undefined),
    verifyInbound: vi.fn().mockReturnValue(true),
  })),
}));

vi.mock('../baileys-runtime.js', () => ({
  BaileysRuntime: vi.fn().mockImplementation(() => ({
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
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
  mockGetSessions.mockResolvedValue({ sessions: [] });
  mockRotateToken.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('SessionManager proactive token rotation', () => {
  it('rotates the token once at startup', async () => {
    const manager = buildManager();
    await manager.start();
    await vi.waitFor(() => expect(mockRotateToken).toHaveBeenCalledTimes(1));
    await manager.stop();
  });

  it('rotates again on the 12h cadence', async () => {
    vi.useFakeTimers();
    const manager = buildManager();
    await manager.start();
    expect(mockRotateToken).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(TOKEN_REFRESH_INTERVAL_MS);
    expect(mockRotateToken).toHaveBeenCalledTimes(2);
    await manager.stop();
  });

  it('swallows a rotation failure without crashing start()', async () => {
    mockRotateToken.mockRejectedValue(new Error('refresh failed: 401'));
    const manager = buildManager();
    await expect(manager.start()).resolves.toBeUndefined();
    await manager.stop();
  });

  it('stops the rotation timer on stop()', async () => {
    vi.useFakeTimers();
    const manager = buildManager();
    await manager.start();
    expect(mockRotateToken).toHaveBeenCalledTimes(1);
    await manager.stop();
    await vi.advanceTimersByTimeAsync(TOKEN_REFRESH_INTERVAL_MS * 2);
    expect(mockRotateToken).toHaveBeenCalledTimes(1);
  });
});

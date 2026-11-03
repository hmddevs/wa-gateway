/**
 * wire.ts, lpushPending atomic transaction test.
 *
 * Tests that lpushPending issues LPUSH, LTRIM and EXPIRE in a single atomic
 * transaction: the pending list is appended to, capped at PENDING_LIST_MAX_LEN
 * entries, and its TTL refreshed on each push.
 *
 * Mocked boundaries:
 *   - getRedis, returns a mock Redis with multi() chain support.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock env so importing wire.ts (which loads env at module-init) doesn't
// trigger real env validation in the test environment.
vi.mock('@/lib/env', () => ({
  env: {},
}));

// Mock getRedis before importing the module under test
vi.mock('@/lib/redis', () => {
  const mockRedis = {
    multi: vi.fn(),
  };
  return {
    getRedis: vi.fn(() => mockRedis),
  };
});

import {
  lpushPending,
  PENDING_LIST_TTL_SECONDS,
  PENDING_LIST_MAX_LEN,
  acceptHeartbeatNonce,
  NONCE_TTL_SECONDS,
} from '../wire';
import { getRedis } from '@/lib/redis';

describe('lpushPending', () => {
  let mockMulti: ReturnType<typeof vi.fn>;
  let mockLpush: ReturnType<typeof vi.fn>;
  let mockLtrim: ReturnType<typeof vi.fn>;
  let mockExpire: ReturnType<typeof vi.fn>;
  let mockTxExec: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();

    // multi() -> lpush() -> ltrim() -> expire() -> exec()
    mockTxExec = vi.fn().mockResolvedValue(['OK', 1, 'OK', 1]);
    mockExpire = vi.fn().mockReturnValue({ exec: mockTxExec });
    mockLtrim = vi.fn().mockReturnValue({ expire: mockExpire });
    mockLpush = vi.fn().mockReturnValue({ ltrim: mockLtrim });
    mockMulti = vi.fn().mockReturnValue({ lpush: mockLpush });

    (getRedis as ReturnType<typeof vi.fn>).mockReturnValue({
      multi: mockMulti,
    });
  });

  it('issues LPUSH, LTRIM and EXPIRE in a single transaction', async () => {
    const sessionId = 'test-session-123';
    const wire = '{"kind":"send","messageId":"msg-001"}';

    await lpushPending(sessionId, wire);

    expect(mockMulti).toHaveBeenCalledOnce();

    expect(mockLpush).toHaveBeenCalledOnce();
    const [key, wireArg] = mockLpush.mock.calls[0] as [string, string];
    expect(key).toBe(`wa:pending:${sessionId}`);
    expect(wireArg).toBe(wire);

    // LTRIM caps the list at PENDING_LIST_MAX_LEN entries; 0..N-1 keeps the head.
    expect(mockLtrim).toHaveBeenCalledOnce();
    const [trimKey, trimStart, trimStop] = mockLtrim.mock.calls[0] as [string, number, number];
    expect(trimKey).toBe(`wa:pending:${sessionId}`);
    expect(trimStart).toBe(0);
    expect(trimStop).toBe(PENDING_LIST_MAX_LEN - 1);

    expect(mockExpire).toHaveBeenCalledOnce();
    const [expireKey, ttl] = mockExpire.mock.calls[0] as [string, number];
    expect(expireKey).toBe(`wa:pending:${sessionId}`);
    expect(ttl).toBe(PENDING_LIST_TTL_SECONDS);

    expect(mockTxExec).toHaveBeenCalledOnce();
  });

  it('throws on Redis transaction failure', async () => {
    mockTxExec.mockRejectedValue(new Error('Redis connection refused'));

    const sessionId = 'test-session-123';
    const wire = '{"kind":"send"}';

    await expect(lpushPending(sessionId, wire)).rejects.toThrow('Redis connection refused');
  });

  it('PENDING_LIST_TTL_SECONDS is 24 hours', () => {
    const expected = 24 * 60 * 60;
    expect(PENDING_LIST_TTL_SECONDS).toBe(expected);
  });

  it('PENDING_LIST_MAX_LEN bounds the list at 1000 entries', () => {
    expect(PENDING_LIST_MAX_LEN).toBe(1000);
  });
});

/**
 * acceptHeartbeatNonce, in-process dedup for the heartbeat kind (never
 * touches Redis; see the rationale comment in wire.ts). Uses fake timers so
 * the 10-minute expiry and sweep-on-check behaviour can be exercised without
 * a real wait.
 */
describe('acceptHeartbeatNonce', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('accepts a nonce the first time it is seen', () => {
    expect(acceptHeartbeatNonce('hb-nonce-1')).toBe(true);
  });

  it('rejects a replayed nonce within the TTL window', () => {
    expect(acceptHeartbeatNonce('hb-nonce-2')).toBe(true);
    expect(acceptHeartbeatNonce('hb-nonce-2')).toBe(false);
  });

  it('accepts the same nonce again once the TTL has elapsed (sweep on check)', () => {
    expect(acceptHeartbeatNonce('hb-nonce-3')).toBe(true);
    vi.advanceTimersByTime(NONCE_TTL_SECONDS * 1_000 + 1);
    expect(acceptHeartbeatNonce('hb-nonce-3')).toBe(true);
  });

  it('does not leak Redis calls, heartbeat dedup never touches getRedis', () => {
    (getRedis as ReturnType<typeof vi.fn>).mockClear();
    acceptHeartbeatNonce('hb-nonce-4');
    acceptHeartbeatNonce('hb-nonce-4');
    expect(getRedis).not.toHaveBeenCalled();
  });
});

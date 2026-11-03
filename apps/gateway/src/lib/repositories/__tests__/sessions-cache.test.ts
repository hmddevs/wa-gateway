/**
 * sessions-cache.test.ts, cache layer unit tests.
 *
 * Tests getCachedSession and invalidateSessionCache against the in-process
 * TtlCache (memory-cache.ts). No Redis involved, the cache is private,
 * single-instance state (see memory-cache.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- env mock ---------------------------------------------------------
vi.stubEnv('GATEWAY_PUBLIC_URL', 'http://localhost:3000');
vi.stubEnv('MONGODB_URI', 'mongodb://test');
vi.stubEnv('UPSTASH_REDIS_URL', 'redis://test');
vi.stubEnv('UPSTASH_REDIS_REST_URL', 'http://test');
vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'token');
vi.stubEnv('SERVER_PEPPER', 'pepper');
vi.stubEnv('INBOUND_ENCRYPTION_KEY', 'key');
vi.stubEnv('WEBHOOK_SIGNING_DEFAULT_SECRET', 'secret');
vi.stubEnv('WEBHOOK_DELIVERY_KEY', 'key');
vi.stubEnv('WORKER_JWT_SIGNING_KEY', 'key');
vi.stubEnv('WORKER_JWT_PUBLIC_KEY', 'key');
vi.stubEnv('WORKER_WIRE_SECRET', 'secret');
vi.stubEnv('NEXTAUTH_URL', 'http://localhost');
vi.stubEnv('NEXTAUTH_SECRET', 'secret');
vi.stubEnv('ADMIN_CREDENTIALS', 'admin:pass');
vi.stubEnv('RESEND_API_KEY', 'key');
vi.stubEnv('ALERTS_FROM_EMAIL', 'test@test.com');
vi.stubEnv('WEBAUTHN_RP_ID', 'test.com');

// ---- module mocks ---------------------------------------------------------
// Short-circuit the env-validating import chain: sessions.ts → mongo.ts → env.ts.
// The cache layer never touches Mongo on hit; cache-miss tests stub the col() call.
const mockFindOne = vi.fn();
vi.mock('@/lib/mongo', () => ({
  col: vi.fn(async () => ({ findOne: mockFindOne })),
}));

// ---- imports after mocks --------------------------------------------------
import { getCachedSession, invalidateSessionCache } from '@/lib/repositories/sessions';
import type { SessionDoc } from '@/lib/repositories/sessions';

// ---------------------------------------------------------------------------

function makeSessionDoc(overrides: Partial<SessionDoc> = {}): SessionDoc {
  const now = new Date();
  return {
    sessionId: 'test-session-1',
    workerId: 'worker-1',
    label: 'Test Session',
    status: 'connected',
    phoneE164: '+447700900123',
    pairing: { event: 'paired', qr: undefined, at: now },
    version: '1.0.0',
    lastHeartbeatAt: now,
    connectedAt: now,
    createdBy: 'admin@test.com',
    createdAt: now,
    stoppedAt: null,
    conversation: {
      sendReadReceipts: true,
      optOutKeywords: ['STOP'],
    },
    historySyncProgress: null,
    ...overrides,
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  // Each test starts from a clean cache: invalidate the fixed session id used
  // throughout this file so a previous test's cached entry never leaks in.
  await invalidateSessionCache('test-session-1');
});

describe('getCachedSession', () => {
  it('returns the cached value on a hit without touching Mongo', async () => {
    const now = new Date('2026-05-21T10:00:00Z');
    const doc = makeSessionDoc({
      createdAt: now,
      lastHeartbeatAt: now,
      connectedAt: now,
      pairing: { event: 'paired', at: now },
    });
    mockFindOne.mockResolvedValue(doc);

    // First call misses and populates the cache from Mongo.
    await getCachedSession('test-session-1');
    expect(mockFindOne).toHaveBeenCalledOnce();

    // Second call within the 5s TTL hits the in-process cache, not Mongo.
    const result = await getCachedSession('test-session-1');
    expect(mockFindOne).toHaveBeenCalledOnce();
    expect(result).toEqual(doc);
  });

  it('falls back to Mongo on a cache miss and populates the cache', async () => {
    const doc = makeSessionDoc();
    mockFindOne.mockResolvedValue(doc);

    const result = await getCachedSession('test-session-1');

    expect(result).toEqual(doc);
    expect(mockFindOne).toHaveBeenCalledOnce();
  });

  it('returns null and does not cache when Mongo has no matching session', async () => {
    mockFindOne.mockResolvedValue(null);

    const result = await getCachedSession('test-session-1');

    expect(result).toBeNull();
    // A second call re-queries Mongo rather than caching the miss.
    await getCachedSession('test-session-1');
    expect(mockFindOne).toHaveBeenCalledTimes(2);
  });

  it('re-queries Mongo once the 5s TTL has elapsed', async () => {
    vi.useFakeTimers();
    try {
      const doc = makeSessionDoc();
      mockFindOne.mockResolvedValue(doc);

      await getCachedSession('test-session-1');
      expect(mockFindOne).toHaveBeenCalledOnce();

      // Still within the TTL: cache hit, no second Mongo read.
      vi.advanceTimersByTime(4999);
      await getCachedSession('test-session-1');
      expect(mockFindOne).toHaveBeenCalledOnce();

      // Past the TTL: the entry has expired, so this falls back to Mongo.
      vi.advanceTimersByTime(2);
      await getCachedSession('test-session-1');
      expect(mockFindOne).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('invalidateSessionCache', () => {
  it('clears the cache entry so the next read goes back to Mongo', async () => {
    const doc = makeSessionDoc();
    mockFindOne.mockResolvedValue(doc);

    await getCachedSession('test-session-1');
    expect(mockFindOne).toHaveBeenCalledOnce();

    await invalidateSessionCache('test-session-1');

    await getCachedSession('test-session-1');
    expect(mockFindOne).toHaveBeenCalledTimes(2);
  });

  it('is a no-op (never throws) for a key that was never cached', async () => {
    await expect(invalidateSessionCache('never-cached')).resolves.toBeUndefined();
  });
});

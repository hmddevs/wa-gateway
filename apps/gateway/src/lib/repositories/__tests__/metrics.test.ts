/**
 * getSessionMetrics, chat_events fold-in and cache key.
 *
 * Verifies that `out_device` chat_events are merged into sentAgg and `in`
 * chat_events are merged into receivedAgg, and that the resulting totals
 * are reflected in `sent24h` / `received24h`. Also asserts that the Redis
 * SET call uses the v2 cache key.
 *
 * Mocked boundaries:
 *   @/lib/mongo, col()
 *   @/lib/redis, getRedis()
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mock handles, must be declared before vi.mock factories run.
// ---------------------------------------------------------------------------

const { mockGet, mockSet, mockToArray } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockSet: vi.fn(),
  mockToArray: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('@/lib/redis', () => ({
  getRedis: vi.fn(() => ({
    get: mockGet,
    set: mockSet,
  })),
}));

// `col` is called with the collection name and returns a collection handle.
// The metrics function calls:
//   col('messages')           → aggregate → toArray (sentAgg, failedCount via countDocuments)
//   col('inbound_messages')   → aggregate → toArray (receivedAgg)
//   col('chat_events')        → aggregate → toArray (chatEventAgg)
//   col('webhook_routes')     → find → toArray (routeIds)
//   col('webhook_deliveries') → aggregate → toArray (webhookAgg) [only when routeIds.length > 0]
//
// We use a factory that maps collection name to a prepared stub response.

const stubs = new Map<string, unknown[] | number>();

vi.mock('@/lib/mongo', () => ({
  col: vi.fn(async (name: string) => {
    return {
      aggregate: () => ({ toArray: () => Promise.resolve(stubs.get(name) ?? []) }),
      find: () => ({ toArray: () => Promise.resolve(stubs.get(name) ?? []) }),
      countDocuments: () => Promise.resolve(stubs.get(`${name}:count`) ?? 0),
    };
  }),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { getSessionMetrics } from '@/lib/repositories/metrics';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type SparkBucket = { hour: number; count: number };

function hours(entries: Array<[number, number]>): SparkBucket[] {
  return entries.map(([hour, count]) => ({ hour, count }));
}

const SESSION_ID = 'test-session-abc';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  stubs.clear();
  // Default: cache miss so the function always recomputes.
  mockGet.mockResolvedValue(null);
  mockSet.mockResolvedValue('OK');
  // Default: no webhook routes so webhook_deliveries branch is skipped.
  stubs.set('webhook_routes', []);
  stubs.set('messages:count', 0);
});

// ---------------------------------------------------------------------------
// chat_events merge into sent24h
// ---------------------------------------------------------------------------

describe('getSessionMetrics, chat_events out_device folds into sent24h', () => {
  it('adds out_device chat_event bucket counts to the messages sent total', async () => {
    // messages collection: 2 sent messages in hour 0.
    stubs.set('messages', hours([[0, 2]]));
    // chat_events $facet returns: 3 out_device in hour 0, 1 in in hour 1.
    stubs.set('chat_events', [{ sent: hours([[0, 3]]), received: hours([[1, 1]]) }]);
    stubs.set('inbound_messages', []);

    const result = await getSessionMetrics(SESSION_ID, 'connected');

    // sent24h = sum of (messages + chat_events.out_device) merged sparkline.
    // messages: hour 0 → 2; chat_events.sent: hour 0 → 3; merged hour 0 → 5.
    expect(result.messages.sent24h).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// chat_events merge into received24h
// ---------------------------------------------------------------------------

describe('getSessionMetrics, chat_events in folds into received24h', () => {
  it('adds in chat_event bucket counts to the inbound received total', async () => {
    // inbound_messages: 1 received in hour 0.
    stubs.set('inbound_messages', hours([[0, 1]]));
    // chat_events: 0 out_device, 4 in (hour 0).
    stubs.set('chat_events', [{ sent: [], received: hours([[0, 4]]) }]);
    stubs.set('messages', []);

    const result = await getSessionMetrics(SESSION_ID, 'connected');

    // received24h = inbound_messages (1) + chat_events.in (4) = 5.
    expect(result.messages.received24h).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Both sides merged simultaneously
// ---------------------------------------------------------------------------

describe('getSessionMetrics, both chat_event sides merge correctly', () => {
  it('merges sent and received independently without cross-contamination', async () => {
    stubs.set('messages', hours([[0, 1]]));
    stubs.set('inbound_messages', hours([[0, 2]]));
    stubs.set('chat_events', [{ sent: hours([[0, 10]]), received: hours([[0, 20]]) }]);

    const result = await getSessionMetrics(SESSION_ID, null);

    expect(result.messages.sent24h).toBe(11); // 1 + 10
    expect(result.messages.received24h).toBe(22); // 2 + 20
  });
});

// ---------------------------------------------------------------------------
// Empty chat_events (no $facet result)
// ---------------------------------------------------------------------------

describe('getSessionMetrics, empty chat_events facet is handled gracefully', () => {
  it('falls back to zero contribution when chatEventAgg is an empty array', async () => {
    stubs.set('messages', hours([[0, 3]]));
    stubs.set('inbound_messages', hours([[0, 5]]));
    stubs.set('chat_events', []); // $facet returns no documents

    const result = await getSessionMetrics(SESSION_ID, 'connected');

    expect(result.messages.sent24h).toBe(3);
    expect(result.messages.received24h).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Cache key is metrics:session:v2:<sessionId>
// ---------------------------------------------------------------------------

describe('getSessionMetrics, cache key uses v2 prefix', () => {
  it('writes to Redis with the v2 cache key on a cache miss', async () => {
    stubs.set('messages', []);
    stubs.set('inbound_messages', []);
    stubs.set('chat_events', [{ sent: [], received: [] }]);

    await getSessionMetrics(SESSION_ID, null);

    expect(mockSet).toHaveBeenCalledOnce();
    const keyArg = mockSet.mock.calls[0]![0] as string;
    expect(keyArg).toBe(`metrics:session:v2:${SESSION_ID}`);
  });

  it('returns cached value without calling Redis SET on a cache hit', async () => {
    const cached = {
      sessionId: SESSION_ID,
      window: { from: new Date(0).toISOString(), to: new Date().toISOString() },
      messages: {
        sent24h: 99,
        received24h: 88,
        failed24h: 0,
        sentSparkline: [],
        receivedSparkline: [],
      },
      webhooks: { delivered24h: 0, failed24h: 0 },
      workerStatus: null,
      cachedAt: new Date().toISOString(),
    };
    mockGet.mockResolvedValue(JSON.stringify(cached));

    const result = await getSessionMetrics(SESSION_ID, null);

    expect(mockSet).not.toHaveBeenCalled();
    expect(result.messages.sent24h).toBe(99);
  });
});

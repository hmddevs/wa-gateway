/**
 * worker-state-cache.test.ts, cache layer unit tests.
 *
 * Tests getCachedWorker and invalidateWorkerCache against the in-process
 * TtlCache (memory-cache.ts). No Redis involved, the cache is private,
 * single-instance state (see memory-cache.ts). Mirrors
 * sessions-cache.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFindOne = vi.fn();
const mockUpdateOne = vi.fn().mockResolvedValue({ matchedCount: 1 });
vi.mock('@/lib/mongo', () => ({
  col: vi.fn(async () => ({ findOne: mockFindOne, updateOne: mockUpdateOne })),
}));

import { getCachedWorker, invalidateWorkerCache } from '@/lib/repositories/worker-state';
import type { WorkerStateDoc } from '@/lib/repositories/worker-state';

function makeWorkerDoc(overrides: Partial<WorkerStateDoc> = {}): WorkerStateDoc {
  return {
    workerId: 'primary',
    status: 'connected',
    lastHeartbeatAt: new Date('2026-05-21T10:00:00Z'),
    connectedAt: new Date('2026-05-21T09:00:00Z'),
    tokenGen: 3,
    ...overrides,
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  await invalidateWorkerCache('primary');
});

describe('getCachedWorker', () => {
  it('returns the cached value on a hit without touching Mongo', async () => {
    const doc = makeWorkerDoc();
    mockFindOne.mockResolvedValue(doc);

    await getCachedWorker('primary');
    expect(mockFindOne).toHaveBeenCalledOnce();

    const result = await getCachedWorker('primary');
    expect(mockFindOne).toHaveBeenCalledOnce();
    expect(result).toEqual(doc);
  });

  it('falls back to Mongo on a cache miss and populates the cache', async () => {
    const doc = makeWorkerDoc();
    mockFindOne.mockResolvedValue(doc);

    const result = await getCachedWorker('primary');

    expect(result).toEqual(doc);
    expect(mockFindOne).toHaveBeenCalledOnce();
  });

  it('returns null and does not cache when Mongo has no matching worker', async () => {
    mockFindOne.mockResolvedValue(null);

    const result = await getCachedWorker('primary');

    expect(result).toBeNull();
    await getCachedWorker('primary');
    expect(mockFindOne).toHaveBeenCalledTimes(2);
  });

  it('re-queries Mongo once the 5s TTL has elapsed', async () => {
    vi.useFakeTimers();
    try {
      const doc = makeWorkerDoc();
      mockFindOne.mockResolvedValue(doc);

      await getCachedWorker('primary');
      expect(mockFindOne).toHaveBeenCalledOnce();

      // Still within the TTL: cache hit, no second Mongo read.
      vi.advanceTimersByTime(4999);
      await getCachedWorker('primary');
      expect(mockFindOne).toHaveBeenCalledOnce();

      // Past the TTL: the entry has expired, so this falls back to Mongo.
      vi.advanceTimersByTime(2);
      await getCachedWorker('primary');
      expect(mockFindOne).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('invalidateWorkerCache', () => {
  it('clears the cache entry so the next read goes back to Mongo (tokenGen bump propagates)', async () => {
    mockFindOne.mockResolvedValue(makeWorkerDoc({ tokenGen: 3 }));
    await getCachedWorker('primary');
    expect(mockFindOne).toHaveBeenCalledOnce();

    await invalidateWorkerCache('primary');

    mockFindOne.mockResolvedValue(makeWorkerDoc({ tokenGen: 4 }));
    const result = await getCachedWorker('primary');
    expect(mockFindOne).toHaveBeenCalledTimes(2);
    expect(result?.tokenGen).toBe(4);
  });

  it('is a no-op (never throws) for a key that was never cached', async () => {
    await expect(invalidateWorkerCache('never-cached')).resolves.toBeUndefined();
  });
});

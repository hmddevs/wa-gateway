/**
 * worker-state repo, soft-delete preserves the tokenGen high-water.
 *
 * A hard delete would drop tokenGen, so a later read sees currentGen 0 and a
 * previously-revoked token would pass the strict `gen < currentGen` wire check
 * again. deleteWorker instead bumps tokenGen and stamps deletedAt, and
 * listAllWorkers hides soft-deleted rows so the admin UI is unchanged.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const findOne = vi.fn();
const updateOne = vi.fn().mockResolvedValue({ matchedCount: 1 });
const find = vi.fn();

vi.mock('@/lib/mongo', () => ({ col: vi.fn(async () => ({ findOne, updateOne, find })) }));
vi.mock('@/lib/redis', () => ({ getRedis: vi.fn(() => ({ del: vi.fn().mockResolvedValue(1) })) }));
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

import { deleteWorker, listAllWorkers } from '@/lib/repositories/worker-state';

beforeEach(() => {
  vi.clearAllMocks();
  updateOne.mockResolvedValue({ matchedCount: 1 });
});

describe('deleteWorker (soft delete)', () => {
  it('bumps tokenGen to current+1 and stamps deletedAt rather than removing the row', async () => {
    findOne.mockResolvedValue({ workerId: 'm1', tokenGen: 7 });
    const ok = await deleteWorker('m1');
    expect(ok).toBe(true);

    const [filter, update] = updateOne.mock.calls[0]!;
    expect(filter).toEqual({ workerId: 'm1' });
    expect(update.$set.tokenGen).toBe(8); // high-water preserved + advanced
    expect(update.$set.deletedAt).toBeInstanceOf(Date);
  });

  it('treats a worker with no tokenGen as 0 → bumps to 1', async () => {
    findOne.mockResolvedValue({ workerId: 'm1' });
    await deleteWorker('m1');
    expect(updateOne.mock.calls[0]![1].$set.tokenGen).toBe(1);
  });

  it('returns false for an unknown worker without writing', async () => {
    findOne.mockResolvedValue(null);
    const ok = await deleteWorker('ghost');
    expect(ok).toBe(false);
    expect(updateOne).not.toHaveBeenCalled();
  });
});

describe('listAllWorkers', () => {
  it('excludes soft-deleted rows', async () => {
    const toArray = vi.fn().mockResolvedValue([{ workerId: 'primary' }]);
    const sort = vi.fn(() => ({ toArray }));
    find.mockReturnValue({ sort });

    const rows = await listAllWorkers();
    expect(rows).toEqual([{ workerId: 'primary' }]);
    // The filter must exclude rows that carry a deletedAt timestamp.
    const filter = find.mock.calls[0]![0];
    expect(filter).toHaveProperty('deletedAt');
  });
});

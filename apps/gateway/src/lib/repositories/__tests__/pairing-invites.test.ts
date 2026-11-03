/**
 * pairing-invites repo, slot claiming and active-only state transitions.
 *
 * The load-bearing behaviour is `recordInviteSession`: the `maxSessions` cap
 * lives inside the update filter, so two people opening the same link at once
 * cannot both take the last slot. `markInviteExpired` and `revokeInvite` both
 * filter on `status: 'active'` so a settled link is a no-op rather than having
 * a terminal state overwritten. Mongo is simulated, no real connection.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const findOneAndUpdate = vi.fn();
const updateOne = vi.fn();
const findOne = vi.fn();
const find = vi.fn();
const insertOne = vi.fn();
const createIndexes = vi.fn().mockResolvedValue(undefined);

vi.mock('@/lib/mongo', () => ({
  col: vi.fn(async () => ({
    findOneAndUpdate,
    updateOne,
    findOne,
    find,
    insertOne,
    createIndexes,
  })),
}));

import {
  recordInviteSession,
  markInviteExpired,
  revokeInvite,
  listInvites,
} from '@/lib/repositories/pairing-invites';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('recordInviteSession', () => {
  it('enforces status, expiry and the cap inside the update filter', async () => {
    findOneAndUpdate.mockResolvedValue({ inviteId: 'pi_1', sessionIds: ['org-a-01'] });
    const now = new Date('2026-01-01T00:00:00Z');

    await recordInviteSession('pi_1', 'org-a-01', now);

    const [filter, update] = findOneAndUpdate.mock.calls[0]!;
    expect(filter.inviteId).toBe('pi_1');
    expect(filter.status).toBe('active');
    expect(filter.expiresAt).toEqual({ $gt: now });
    // The cap is compared server-side, not read-then-written by the caller, // that is what makes concurrent claims safe.
    expect(filter.$expr).toEqual({ $lt: [{ $size: '$sessionIds' }, '$maxSessions'] });
    expect(update).toEqual({ $push: { sessionIds: 'org-a-01' } });
  });

  it('returns null when the link is full, expired or revoked', async () => {
    // One null covers all three: the filter matched zero documents, and the
    // caller cannot tell which clause rejected it (nor does it need to).
    findOneAndUpdate.mockResolvedValue(null);

    await expect(recordInviteSession('pi_full', 'org-a-06')).resolves.toBeNull();
  });
});

describe('markInviteExpired', () => {
  it('only transitions a link that is still active', async () => {
    updateOne.mockResolvedValue({ modifiedCount: 1 });

    await markInviteExpired('pi_1');

    const [filter, update] = updateOne.mock.calls[0]!;
    expect(filter).toEqual({ inviteId: 'pi_1', status: 'active' });
    expect(update).toEqual({ $set: { status: 'expired' } });
  });
});

describe('revokeInvite', () => {
  it('reports true only when it actually revoked an active link', async () => {
    updateOne.mockResolvedValue({ modifiedCount: 1 });
    await expect(revokeInvite('pi_1')).resolves.toBe(true);

    updateOne.mockResolvedValue({ modifiedCount: 0 });
    await expect(revokeInvite('pi_already-revoked')).resolves.toBe(false);
  });
});

describe('listInvites', () => {
  it('never projects the token hashes', async () => {
    const toArray = vi.fn().mockResolvedValue([]);
    find.mockReturnValue({ sort: () => ({ limit: () => ({ toArray }) }) });

    await listInvites('org-a');

    const [filter, options] = find.mock.calls[0]!;
    expect(filter).toEqual({ orgId: 'org-a' });
    // The raw token is unrecoverable by design; the hashes must not leak into
    // an admin listing either.
    expect(options.projection).toEqual({ tokenHash: 0, lookupHash: 0 });
  });
});

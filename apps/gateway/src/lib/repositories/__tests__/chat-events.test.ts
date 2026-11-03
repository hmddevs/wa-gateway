/**
 * insertChatEvent, duplicate-key deduplication.
 *
 * Mocked boundaries:
 *   @/lib/mongo, chatEvents() collection
 *
 * The uniqueness constraint on (sessionId, waMessageId) means the worker may
 * re-deliver the same event after a reconnect. A Mongo 11000 error MUST be
 * swallowed and surfaced as { duplicate: true }. Any other error MUST rethrow.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- module mocks -----------------------------------------------------------
// vi.mock is hoisted to the top of the file, so the factory must not reference
// variables declared in the module body. We capture the spy via vi.hoisted so
// it is available both inside the factory and in the test assertions.

const { mockInsertOne, mockAggregateToArray, mockAggregate } = vi.hoisted(() => ({
  mockInsertOne: vi.fn(),
  mockAggregateToArray: vi.fn(),
  mockAggregate: vi.fn(),
}));

vi.mock('@/lib/mongo', () => ({
  chatEvents: vi.fn().mockResolvedValue({
    insertOne: mockInsertOne,
    aggregate: mockAggregate,
  }),
}));

// ---- imports after mocks ----------------------------------------------------

import { insertChatEvent, listSessionGroups } from '@/lib/repositories/chat-events';

// ---------------------------------------------------------------------------
// Shared fixture
// ---------------------------------------------------------------------------

const DOC = {
  sessionId: 'session-1',
  workerId: 'worker-1',
  waMessageId: 'wa-msg-001',
  direction: 'out_device' as const,
  source: 'live' as const,
  counterpartyJid: '447700900000@s.whatsapp.net',
  counterpartyE164: '+447700900000' as string | null,
  content: { kind: 'text' as const, text: 'Hello' },
  ts: new Date('2026-04-29T12:00:00.000Z'),
};

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockAggregate.mockReturnValue({ toArray: mockAggregateToArray });
});

// ---------------------------------------------------------------------------
// First insertion succeeds
// ---------------------------------------------------------------------------

describe('insertChatEvent, first insert', () => {
  it('returns { duplicate: false } when the document is new', async () => {
    mockInsertOne.mockResolvedValueOnce({ insertedId: 'some-id' });
    const result = await insertChatEvent(DOC);
    expect(result).toEqual({ duplicate: false });
    expect(mockInsertOne).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Second insertion, duplicate key
// ---------------------------------------------------------------------------

describe('insertChatEvent, duplicate key (11000)', () => {
  it('returns { duplicate: true } when the same (sessionId, waMessageId) is inserted again', async () => {
    const dupError = Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
    mockInsertOne.mockRejectedValueOnce(dupError);
    const result = await insertChatEvent(DOC);
    expect(result).toEqual({ duplicate: true });
  });
});

// ---------------------------------------------------------------------------
// listSessionGroups, tenant-isolation query shape
// ---------------------------------------------------------------------------

describe('listSessionGroups, query shape', () => {
  it('matches strictly on the given sessionId, only counts @g.us JIDs with counterpartyE164: null', async () => {
    mockAggregateToArray.mockResolvedValueOnce([]);

    await listSessionGroups('session-a');

    expect(mockAggregate).toHaveBeenCalledOnce();
    const pipeline = mockAggregate.mock.calls[0]![0] as Array<Record<string, unknown>>;
    const matchStage = pipeline[0]!.$match as Record<string, unknown>;
    // why: this $match is the ENTIRE tenant-isolation boundary for
    // GET /v1/groups, it must scope on exactly the caller's own sessionId,
    // never a broader or caller-suppliable filter.
    expect(matchStage).toEqual({
      sessionId: 'session-a',
      counterpartyE164: null,
      counterpartyJid: { $regex: '@g\\.us$' },
    });
  });

  it('maps aggregation rows to { jid, lastActivityAt }', async () => {
    const lastActivityAt = new Date('2026-07-01T00:00:00.000Z');
    mockAggregateToArray.mockResolvedValueOnce([
      { jid: '120363012345678901@g.us', lastActivityAt },
    ]);

    const result = await listSessionGroups('session-a');

    expect(result).toEqual([{ jid: '120363012345678901@g.us', lastActivityAt }]);
  });

  it('returns an empty array when the session has no group activity', async () => {
    mockAggregateToArray.mockResolvedValueOnce([]);
    const result = await listSessionGroups('session-a');
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Non-duplicate error is rethrown
// ---------------------------------------------------------------------------

describe('insertChatEvent, non-duplicate error', () => {
  it('rethrows an error whose code is not 11000', async () => {
    const networkError = Object.assign(new Error('connection reset'), { code: 'NetworkError' });
    mockInsertOne.mockRejectedValueOnce(networkError);
    await expect(insertChatEvent(DOC)).rejects.toThrow('connection reset');
  });

  it('rethrows an error with a numeric non-11000 code', async () => {
    const otherError = Object.assign(new Error('write concern error'), { code: 64 });
    mockInsertOne.mockRejectedValueOnce(otherError);
    await expect(insertChatEvent(DOC)).rejects.toMatchObject({ code: 64 });
  });
});

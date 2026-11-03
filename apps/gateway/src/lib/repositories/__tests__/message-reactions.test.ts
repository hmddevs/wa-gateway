/**
 * upsertReactionFromEvent, replace-on-conflict invariants.
 *
 * Mocked boundaries:
 *   @/lib/mongo, messageReactions() collection
 *   @/lib/repositories/messages, findByWaMessageId
 *
 * The repo enforces three contracts:
 *   1. Replace-on-conflict per `(sessionId, waMessageId, fromJid)`, DB-side
 *      via the unique index, route-side via `replaceOne(upsert: true)`.
 *   2. When `targetFromMe` is true, resolve the gateway UUID via
 *      `findByWaMessageId` and stamp `messageId`.
 *   3. Cleared reactions (`emoji === ''`) still produce a row, the audit
 *      trail is preserved at the DB level; viewer projection filters them
 *      out for rendering.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockReplaceOne, mockFindByWaMessageId } = vi.hoisted(() => ({
  mockReplaceOne: vi.fn(),
  mockFindByWaMessageId: vi.fn(),
}));

vi.mock('@/lib/mongo', () => ({
  messageReactions: vi.fn().mockResolvedValue({
    replaceOne: mockReplaceOne,
  }),
}));

vi.mock('@/lib/repositories/messages', () => ({
  findByWaMessageId: mockFindByWaMessageId,
}));

import { upsertReactionFromEvent } from '@/lib/repositories/message-reactions';

const SESSION = 'session-1';
const WAMID = 'BAE5ABCDEF0123456789';
const FROM_JID = '447700900000@s.whatsapp.net';
const AT = '2026-05-10T12:00:00.000Z';
const MSG_UUID = '00000000-0000-4000-8000-000000000001';

beforeEach(() => {
  vi.clearAllMocks();
  mockFindByWaMessageId.mockResolvedValue(null);
  mockReplaceOne.mockResolvedValue({ upsertedCount: 1, matchedCount: 0 });
});

describe('upsertReactionFromEvent, filter shape', () => {
  it('calls replaceOne with the (sessionId, waMessageId, fromJid) filter and upsert: true', async () => {
    await upsertReactionFromEvent(SESSION, {
      targetWaMessageId: WAMID,
      targetFromMe: false,
      fromJid: FROM_JID,
      emoji: '👍',
      at: AT,
    });
    expect(mockReplaceOne).toHaveBeenCalledTimes(1);
    const [filter, , options] = mockReplaceOne.mock.calls[0]!;
    expect(filter).toEqual({ sessionId: SESSION, waMessageId: WAMID, fromJid: FROM_JID });
    expect(options).toEqual({ upsert: true });
  });
});

describe('upsertReactionFromEvent, outbound target resolves messageId', () => {
  it('stamps messageId when targetFromMe and findByWaMessageId returns the doc', async () => {
    mockFindByWaMessageId.mockResolvedValueOnce({ messageId: MSG_UUID });
    await upsertReactionFromEvent(SESSION, {
      targetWaMessageId: WAMID,
      targetFromMe: true,
      fromJid: FROM_JID,
      emoji: '❤️',
      at: AT,
    });
    const [, doc] = mockReplaceOne.mock.calls[0]!;
    expect((doc as { messageId?: string }).messageId).toBe(MSG_UUID);
    expect((doc as { targetFromMe: boolean }).targetFromMe).toBe(true);
  });

  it('omits messageId when target is not outbound', async () => {
    await upsertReactionFromEvent(SESSION, {
      targetWaMessageId: WAMID,
      targetFromMe: false,
      fromJid: FROM_JID,
      emoji: '👍',
      at: AT,
    });
    expect(mockFindByWaMessageId).not.toHaveBeenCalled();
    const [, doc] = mockReplaceOne.mock.calls[0]!;
    expect((doc as { messageId?: string }).messageId).toBeUndefined();
  });

  it('omits messageId when targetFromMe but lookup misses (race: ack not yet landed)', async () => {
    mockFindByWaMessageId.mockResolvedValueOnce(null);
    await upsertReactionFromEvent(SESSION, {
      targetWaMessageId: WAMID,
      targetFromMe: true,
      fromJid: FROM_JID,
      emoji: '👍',
      at: AT,
    });
    const [, doc] = mockReplaceOne.mock.calls[0]!;
    expect((doc as { messageId?: string }).messageId).toBeUndefined();
  });
});

describe('upsertReactionFromEvent, cleared reaction', () => {
  it('persists an empty-string emoji (the audit row stays)', async () => {
    await upsertReactionFromEvent(SESSION, {
      targetWaMessageId: WAMID,
      targetFromMe: false,
      fromJid: FROM_JID,
      emoji: '',
      at: AT,
    });
    expect(mockReplaceOne).toHaveBeenCalledTimes(1);
    const [, doc] = mockReplaceOne.mock.calls[0]!;
    expect((doc as { emoji: string }).emoji).toBe('');
  });
});

describe('upsertReactionFromEvent, fromE164 derivation', () => {
  it('derives a `+E.164` for `@s.whatsapp.net` JIDs', async () => {
    await upsertReactionFromEvent(SESSION, {
      targetWaMessageId: WAMID,
      targetFromMe: false,
      fromJid: '447700900000@s.whatsapp.net',
      emoji: '👍',
      at: AT,
    });
    const [, doc] = mockReplaceOne.mock.calls[0]!;
    expect((doc as { fromE164: string | null }).fromE164).toBe('+447700900000');
  });

  it('returns null fromE164 for group-style JIDs', async () => {
    await upsertReactionFromEvent(SESSION, {
      targetWaMessageId: WAMID,
      targetFromMe: false,
      fromJid: '12036311111111@g.us',
      emoji: '👍',
      at: AT,
    });
    const [, doc] = mockReplaceOne.mock.calls[0]!;
    expect((doc as { fromE164: string | null }).fromE164).toBeNull();
  });
});

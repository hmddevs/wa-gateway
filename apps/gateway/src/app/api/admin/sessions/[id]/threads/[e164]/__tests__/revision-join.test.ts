/**
 * GET /api/admin/sessions/:id/threads/:e164, revision join behaviour.
 *
 * The route calls `listThreadMessages` (MongoDB `$lookup` aggregation) and
 * projects `revisions`, `latestBody`, `editedAt`, `deletedAt` onto each item.
 * Because `mongodb-memory-server` is not a dev dep, `listThreadMessages` is
 * mocked. The tests assert the route's projection logic, not the Mongo
 * pipeline.
 *
 * NOTE: The `$lookup` / `$or` reconciliation for revisions whose `messageId`
 * was inserted as `null` (race: revision arrived before original) is
 * exercised inside the aggregation pipeline in `messages.ts`. A mock cannot
 * reach that logic; it is flagged below as integration-test debt.
 *
 * Mocked boundaries:
 *   - @/lib/require-admin
 *   - @/lib/repositories/sessions, getSession
 *   - @/lib/repositories/messages, listThreadMessages
 *   - @/lib/admin-rate-limit, checkAdminLimit, adminLimiterKey
 *   - @/lib/cursors, decodeAdminThreadCursor, encodeAdminThreadCursor
 *   - @/lib/logger, logger
 *   - @/lib/request-id, mintRequestId
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- module mocks -----------------------------------------------------------

vi.mock('@/lib/require-admin', () => ({
  requireAdmin: vi.fn(),
}));

vi.mock('@/lib/repositories/sessions', () => ({
  getSession: vi.fn(),
  getCachedSession: vi.fn(),
}));

vi.mock('@/lib/repositories/messages', () => ({
  listThreadMessages: vi.fn(),
}));

vi.mock('@/lib/admin-rate-limit', () => ({
  adminLimiterKey: vi.fn(() => 'sess:admin-sess-1'),
  checkAdminLimit: vi.fn().mockResolvedValue(true),
}));

vi.mock('@/lib/cursors', () => ({
  decodeAdminThreadCursor: vi.fn().mockReturnValue(null),
  encodeAdminThreadCursor: vi.fn().mockReturnValue('cursor-token'),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/request-id', () => ({
  mintRequestId: vi.fn(() => 'req-test'),
}));

// ---- imports after mocks ----------------------------------------------------

import { GET } from '@/app/api/admin/sessions/[id]/threads/[e164]/route';
import { requireAdmin } from '@/lib/require-admin';
import { getSession } from '@/lib/repositories/sessions';
import { listThreadMessages } from '@/lib/repositories/messages';
import type {
  AdminThreadMessageReaction,
  AdminThreadMessageReplyTo,
  AdminThreadMessageRevision,
} from '@/lib/repositories/messages';

// ---------------------------------------------------------------------------
// Typed mock references
// ---------------------------------------------------------------------------

const mockRequireAdmin = requireAdmin as ReturnType<typeof vi.fn>;
const mockGetSession = getSession as ReturnType<typeof vi.fn>;
const mockListThreadMessages = listThreadMessages as ReturnType<typeof vi.fn>;

const SESSION_ID = 'test-session';
const E164 = '+447700900000';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAdminContext() {
  return {
    ok: true as const,
    admin: { email: 'admin@test.com', sessionId: 'admin-sess-1', webauthnFreshAt: null },
  };
}

function makeSession() {
  return {
    sessionId: SESSION_ID,
    workerId: 'worker-1',
    label: 'Test',
    status: 'connected',
    phoneE164: '+447700900000',
  };
}

function makeParams(id: string, e164: string): Promise<{ id: string; e164: string }> {
  return Promise.resolve({ id, e164 });
}

function makeGetRequest(sessionId: string, e164: string, query = ''): Request {
  return new Request(
    `https://wa.test/api/admin/sessions/${sessionId}/threads/${encodeURIComponent(e164)}${query}`,
    { method: 'GET' },
  );
}

// Minimal thread message builder used across tests.
// why: `listThreadMessages` returns `AdminThreadMessageDoc` objects that
// already include derived fields (`editedAt`, `deletedAt`, `latestBody`)
// computed by `deriveRevisionState`. The route just forwards them. The mock
// must supply the pre-derived state so route projection tests are accurate.
function makeMessage(
  overrides: {
    messageId?: string;
    direction?: 'in' | 'out';
    ts?: Date;
    body?: { kind: 'text'; text: string };
    revisions?: AdminThreadMessageRevision[];
    latestBody?: { kind: 'text'; text: string };
    editedAt?: string;
    deletedAt?: string;
    replyTo?: AdminThreadMessageReplyTo;
    reactions?: AdminThreadMessageReaction[];
  } = {},
) {
  return {
    messageId: overrides.messageId ?? 'msg-' + Math.random().toString(36).slice(2),
    direction: overrides.direction ?? 'out',
    ts: overrides.ts ?? new Date(),
    body: overrides.body ?? { kind: 'text' as const, text: 'Hello' },
    _cursorId: 'cursor-' + Math.random().toString(36).slice(2),
    status: 'delivered',
    revisions: overrides.revisions ?? [],
    ...(overrides.latestBody !== undefined ? { latestBody: overrides.latestBody } : {}),
    ...(overrides.editedAt !== undefined ? { editedAt: overrides.editedAt } : {}),
    ...(overrides.deletedAt !== undefined ? { deletedAt: overrides.deletedAt } : {}),
    ...(overrides.replyTo !== undefined ? { replyTo: overrides.replyTo } : {}),
    ...(overrides.reactions !== undefined ? { reactions: overrides.reactions } : {}),
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAdmin.mockResolvedValue(makeAdminContext());
  mockGetSession.mockResolvedValue(makeSession());
  mockListThreadMessages.mockResolvedValue({ items: [], nextCursor: null });
});

// ---------------------------------------------------------------------------
// m1: two edit revisions, latest body and editedAt set correctly
// ---------------------------------------------------------------------------

describe('revision_join, m1 carries two edit revisions', () => {
  const TS1 = '2026-05-10T10:00:00.000Z';
  const TS2 = '2026-05-10T11:00:00.000Z';

  const rev1: AdminThreadMessageRevision = {
    revisionSeq: 1,
    kind: 'edit',
    body: { kind: 'text', text: 'Body B1' },
    ts: TS1,
  };
  const rev2: AdminThreadMessageRevision = {
    revisionSeq: 2,
    kind: 'edit',
    body: { kind: 'text', text: 'Body B2' },
    ts: TS2,
  };

  it('response has revisions.length === 2 for m1', async () => {
    mockListThreadMessages.mockResolvedValueOnce({
      items: [
        makeMessage({
          messageId: 'm1',
          revisions: [rev1, rev2],
          editedAt: TS2,
          latestBody: { kind: 'text', text: 'Body B2' },
        }),
      ],
      nextCursor: null,
    });
    const res = await GET(makeGetRequest(SESSION_ID, E164), {
      params: makeParams(SESSION_ID, E164),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ messageId: string; revisions?: unknown[] }>;
    };
    const m1 = body.items.find((i) => i.messageId === 'm1');
    expect(m1?.revisions).toHaveLength(2);
  });

  it('editedAt on m1 is the ts of revision 2 (most-recent edit)', async () => {
    mockListThreadMessages.mockResolvedValueOnce({
      items: [
        makeMessage({
          messageId: 'm1',
          revisions: [rev1, rev2],
          editedAt: TS2,
          latestBody: { kind: 'text', text: 'Body B2' },
        }),
      ],
      nextCursor: null,
    });
    const res = await GET(makeGetRequest(SESSION_ID, E164), {
      params: makeParams(SESSION_ID, E164),
    });
    const body = (await res.json()) as { items: Array<{ messageId: string; editedAt?: string }> };
    const m1 = body.items.find((i) => i.messageId === 'm1');
    expect(m1?.editedAt).toBe(TS2);
  });

  it('latestBody on m1 reflects Body B2', async () => {
    mockListThreadMessages.mockResolvedValueOnce({
      items: [
        makeMessage({
          messageId: 'm1',
          revisions: [rev1, rev2],
          editedAt: TS2,
          latestBody: { kind: 'text', text: 'Body B2' },
        }),
      ],
      nextCursor: null,
    });
    const res = await GET(makeGetRequest(SESSION_ID, E164), {
      params: makeParams(SESSION_ID, E164),
    });
    const body = (await res.json()) as {
      items: Array<{ messageId: string; latestBody?: { kind: string; text?: string } }>;
    };
    const m1 = body.items.find((i) => i.messageId === 'm1');
    expect(m1?.latestBody).toEqual({ kind: 'text', text: 'Body B2' });
  });
});

// ---------------------------------------------------------------------------
// m2: one delete revision, deletedAt set, latestBody absent
// ---------------------------------------------------------------------------

describe('revision_join, m2 has a delete revision', () => {
  const DEL_TS = '2026-05-10T12:00:00.000Z';
  const delRev: AdminThreadMessageRevision = {
    revisionSeq: 1,
    kind: 'delete',
    deletedBy: 'self',
    ts: DEL_TS,
  };

  it('response has revisions.length === 1 for m2', async () => {
    mockListThreadMessages.mockResolvedValueOnce({
      items: [makeMessage({ messageId: 'm2', revisions: [delRev], deletedAt: DEL_TS })],
      nextCursor: null,
    });
    const res = await GET(makeGetRequest(SESSION_ID, E164), {
      params: makeParams(SESSION_ID, E164),
    });
    const body = (await res.json()) as {
      items: Array<{ messageId: string; revisions?: unknown[] }>;
    };
    const m2 = body.items.find((i) => i.messageId === 'm2');
    expect(m2?.revisions).toHaveLength(1);
  });

  it('deletedAt is set on m2', async () => {
    mockListThreadMessages.mockResolvedValueOnce({
      items: [makeMessage({ messageId: 'm2', revisions: [delRev], deletedAt: DEL_TS })],
      nextCursor: null,
    });
    const res = await GET(makeGetRequest(SESSION_ID, E164), {
      params: makeParams(SESSION_ID, E164),
    });
    const body = (await res.json()) as { items: Array<{ messageId: string; deletedAt?: string }> };
    const m2 = body.items.find((i) => i.messageId === 'm2');
    expect(m2?.deletedAt).toBe(DEL_TS);
  });

  it('latestBody is absent on m2 (message was deleted)', async () => {
    mockListThreadMessages.mockResolvedValueOnce({
      items: [makeMessage({ messageId: 'm2', revisions: [delRev], deletedAt: DEL_TS })],
      nextCursor: null,
    });
    const res = await GET(makeGetRequest(SESSION_ID, E164), {
      params: makeParams(SESSION_ID, E164),
    });
    const body = (await res.json()) as {
      items: Array<{ messageId: string; latestBody?: unknown }>;
    };
    const m2 = body.items.find((i) => i.messageId === 'm2');
    expect(m2?.latestBody).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// m3: no revisions, revisions absent or empty, latestBody absent
// ---------------------------------------------------------------------------

describe('revision_join, m3 has no revisions', () => {
  it('revisions field is absent or empty on m3', async () => {
    mockListThreadMessages.mockResolvedValueOnce({
      items: [makeMessage({ messageId: 'm3', revisions: [] })],
      nextCursor: null,
    });
    const res = await GET(makeGetRequest(SESSION_ID, E164), {
      params: makeParams(SESSION_ID, E164),
    });
    const body = (await res.json()) as {
      items: Array<{ messageId: string; revisions?: unknown[]; latestBody?: unknown }>;
    };
    const m3 = body.items.find((i) => i.messageId === 'm3');
    // Route omits revisions when the array is empty (route.ts line 91-93).
    expect(m3?.revisions === undefined || m3?.revisions?.length === 0).toBe(true);
    expect(m3?.latestBody).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Auth: unauthenticated request
// ---------------------------------------------------------------------------

describe('revision_join, auth: unauthenticated request', () => {
  it('returns 401 when requireAdmin fails', async () => {
    mockRequireAdmin.mockResolvedValueOnce({ ok: false, status: 401, message: 'Not signed in' });
    const res = await GET(makeGetRequest(SESSION_ID, E164), {
      params: makeParams(SESSION_ID, E164),
    });
    expect(res.status).toBe(401);
    expect(mockListThreadMessages).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// slice 4b, replyTo projection
// ---------------------------------------------------------------------------

describe('reply_to_join, outbound row carrying replyTo with bodyPreview', () => {
  const replyTo: AdminThreadMessageReplyTo = {
    messageId: '00000000-0000-4000-8000-000000000001',
    waMessageId: 'BAE5ORIGINALWAID',
    fromMe: true,
    bodyPreview: 'The quoted original body',
  };

  it('projects replyTo onto the response item', async () => {
    mockListThreadMessages.mockResolvedValueOnce({
      items: [makeMessage({ messageId: 'm-reply', replyTo })],
      nextCursor: null,
    });
    const res = await GET(makeGetRequest(SESSION_ID, E164), {
      params: makeParams(SESSION_ID, E164),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ messageId: string; replyTo?: AdminThreadMessageReplyTo }>;
    };
    const m = body.items.find((i) => i.messageId === 'm-reply');
    expect(m?.replyTo).toEqual(replyTo);
  });

  it('omits replyTo when the row has none', async () => {
    mockListThreadMessages.mockResolvedValueOnce({
      items: [makeMessage({ messageId: 'm-no-reply' })],
      nextCursor: null,
    });
    const res = await GET(makeGetRequest(SESSION_ID, E164), {
      params: makeParams(SESSION_ID, E164),
    });
    const body = (await res.json()) as {
      items: Array<{ messageId: string; replyTo?: unknown }>;
    };
    const m = body.items.find((i) => i.messageId === 'm-no-reply');
    expect(m?.replyTo).toBeUndefined();
  });

  it('projects replyTo without bodyPreview when the original is missing', async () => {
    const minimal: AdminThreadMessageReplyTo = {
      messageId: null,
      waMessageId: 'BAE5MISSINGWAID',
      fromMe: false,
    };
    mockListThreadMessages.mockResolvedValueOnce({
      items: [makeMessage({ messageId: 'm-orphan-reply', replyTo: minimal })],
      nextCursor: null,
    });
    const res = await GET(makeGetRequest(SESSION_ID, E164), {
      params: makeParams(SESSION_ID, E164),
    });
    const body = (await res.json()) as {
      items: Array<{ messageId: string; replyTo?: AdminThreadMessageReplyTo }>;
    };
    const m = body.items.find((i) => i.messageId === 'm-orphan-reply');
    expect(m?.replyTo?.bodyPreview).toBeUndefined();
    expect(m?.replyTo?.waMessageId).toBe('BAE5MISSINGWAID');
    expect(m?.replyTo?.messageId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// slice 4b, reactions projection
// ---------------------------------------------------------------------------

describe('reactions_join, message carrying reactions', () => {
  const TS_RX = '2026-05-10T12:00:00.000Z';
  const reactions: AdminThreadMessageReaction[] = [
    {
      fromJid: '447700900000@s.whatsapp.net',
      fromE164: '+447700900000',
      emoji: '👍',
      ts: TS_RX,
    },
    {
      fromJid: '447700900001@s.whatsapp.net',
      fromE164: '+447700900001',
      emoji: '❤️',
      ts: TS_RX,
    },
  ];

  it('projects reactions onto the response item', async () => {
    mockListThreadMessages.mockResolvedValueOnce({
      items: [makeMessage({ messageId: 'm-reacted', reactions })],
      nextCursor: null,
    });
    const res = await GET(makeGetRequest(SESSION_ID, E164), {
      params: makeParams(SESSION_ID, E164),
    });
    const body = (await res.json()) as {
      items: Array<{ messageId: string; reactions?: AdminThreadMessageReaction[] }>;
    };
    const m = body.items.find((i) => i.messageId === 'm-reacted');
    expect(m?.reactions).toHaveLength(2);
    expect(m?.reactions?.[0]?.emoji).toBe('👍');
  });

  it('omits the reactions field when the array is empty', async () => {
    mockListThreadMessages.mockResolvedValueOnce({
      items: [makeMessage({ messageId: 'm-no-react', reactions: [] })],
      nextCursor: null,
    });
    const res = await GET(makeGetRequest(SESSION_ID, E164), {
      params: makeParams(SESSION_ID, E164),
    });
    const body = (await res.json()) as {
      items: Array<{ messageId: string; reactions?: unknown[] }>;
    };
    const m = body.items.find((i) => i.messageId === 'm-no-react');
    expect(m?.reactions).toBeUndefined();
  });
});

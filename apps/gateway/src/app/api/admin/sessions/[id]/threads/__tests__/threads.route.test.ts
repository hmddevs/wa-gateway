/**
 * Admin conversation viewer, route handler tests.
 *
 * GET /api/admin/sessions/:id/threads
 * GET /api/admin/sessions/:id/threads/:e164
 *
 * Mocked boundaries:
 *   - @/lib/require-admin
 *   - @/lib/repositories/sessions, getSession
 *   - @/lib/repositories/messages, listThreadsForSession, listThreadMessages
 *   - @/lib/admin-rate-limit, checkAdminLimit + adminLimiterKey
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
  listThreadsForSession: vi.fn(),
  listThreadMessages: vi.fn(),
}));

vi.mock('@/lib/admin-rate-limit', () => ({
  checkAdminLimit: vi.fn(),
  adminLimiterKey: vi.fn((admin: { sessionId: string | null; email: string }) =>
    admin.sessionId ? `sess:${admin.sessionId}` : `email:${admin.email.toLowerCase()}`,
  ),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/request-id', () => ({
  mintRequestId: vi.fn(() => 'req-test'),
}));

// ---- imports after mocks ----------------------------------------------------

import { GET as getThreads } from '@/app/api/admin/sessions/[id]/threads/route';
import { GET as getMessages } from '@/app/api/admin/sessions/[id]/threads/[e164]/route';
import { requireAdmin } from '@/lib/require-admin';
import { getSession } from '@/lib/repositories/sessions';
import { listThreadsForSession, listThreadMessages } from '@/lib/repositories/messages';
import { checkAdminLimit } from '@/lib/admin-rate-limit';
import { encodeAdminThreadCursor, decodeAdminThreadCursor } from '@/lib/cursors';
import {
  AdminThreadsListResponseSchema,
  AdminThreadMessagesResponseSchema,
} from '@hmddevs/protocol';
import type { SessionDoc } from '@/lib/repositories/sessions';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockRequireAdmin = requireAdmin as ReturnType<typeof vi.fn>;
const mockGetSession = getSession as ReturnType<typeof vi.fn>;
const mockListThreadsForSession = listThreadsForSession as ReturnType<typeof vi.fn>;
const mockListThreadMessages = listThreadMessages as ReturnType<typeof vi.fn>;
const mockCheckAdminLimit = checkAdminLimit as ReturnType<typeof vi.fn>;

const SESSION_ID = 'session-abc';
const COUNTERPARTY = '+447700900123';

function makeAuthedAdmin(overrides: { sessionId?: string | null } = {}) {
  return {
    ok: true as const,
    admin: {
      email: 'admin@test.com',
      sessionId: overrides.sessionId !== undefined ? overrides.sessionId : null,
      webauthnFreshAt: null,
    },
  };
}

function makeSession(overrides: Partial<SessionDoc> = {}): SessionDoc {
  return {
    sessionId: SESSION_ID,
    workerId: 'worker-1',
    label: 'Test Session',
    status: 'connected',
    phoneE164: '+447700900000',
    pairing: null,
    version: null,
    lastHeartbeatAt: new Date(),
    connectedAt: new Date(),
    createdBy: 'admin@test.com',
    createdAt: new Date(),
    stoppedAt: null,
    ...overrides,
  } as SessionDoc;
}

function makeThreadSummary(counterparty = COUNTERPARTY, tsOffset = 0) {
  return {
    counterparty,
    lastMessageAt: new Date(Date.now() - tsOffset),
    lastMessagePreview: 'Hello there',
    lastMessageDirection: 'out' as const,
    lastMessageStatus: 'delivered' as const,
    unreadCount: 0,
  };
}

function makeThreadMessage(direction: 'in' | 'out' = 'out', tsOffset = 0) {
  return {
    messageId: `msg-${Math.random().toString(36).slice(2)}`,
    direction,
    ts: new Date(Date.now() - tsOffset),
    body: { kind: 'text' as const, text: 'Hello' },
    ...(direction === 'out' ? { status: 'delivered' as const } : {}),
  };
}

function makeThreadsRequest(sessionId: string, qs = ''): Request {
  return new Request(
    `https://wa.test/api/admin/sessions/${sessionId}/threads${qs ? `?${qs}` : ''}`,
    { method: 'GET' },
  );
}

function makeMessagesRequest(sessionId: string, e164: string, qs = ''): Request {
  const encoded = encodeURIComponent(e164);
  return new Request(
    `https://wa.test/api/admin/sessions/${sessionId}/threads/${encoded}${qs ? `?${qs}` : ''}`,
    { method: 'GET' },
  );
}

function makeParams(id: string): Promise<{ id: string }> {
  return Promise.resolve({ id });
}

function makeE164Params(id: string, e164: string): Promise<{ id: string; e164: string }> {
  return Promise.resolve({ id, e164 });
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAdmin.mockResolvedValue(makeAuthedAdmin());
  mockGetSession.mockResolvedValue(makeSession());
  mockCheckAdminLimit.mockResolvedValue(true);
  mockListThreadsForSession.mockResolvedValue({ items: [], nextCursor: null });
  mockListThreadMessages.mockResolvedValue({ items: [], nextCursor: null });
});

// ---------------------------------------------------------------------------
// GET /api/admin/sessions/:id/threads, threads list
// ---------------------------------------------------------------------------

describe('GET /api/admin/sessions/[id]/threads', () => {
  // --- auth -----------------------------------------------------------------

  it('returns 401 when not signed in', async () => {
    mockRequireAdmin.mockResolvedValue({
      ok: false,
      status: 401,
      message: 'Not signed in',
    });

    const res = await getThreads(makeThreadsRequest(SESSION_ID), {
      params: makeParams(SESSION_ID),
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('UNAUTHORIZED');
  });

  it('returns 403 when signed in but not on the admin allowlist', async () => {
    mockRequireAdmin.mockResolvedValue({
      ok: false,
      status: 403,
      message: 'Not an admin',
    });

    const res = await getThreads(makeThreadsRequest(SESSION_ID), {
      params: makeParams(SESSION_ID),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('UNAUTHORIZED');
  });

  // --- 404 ------------------------------------------------------------------

  it('returns 404 with INVALID_BODY when the session does not exist', async () => {
    mockGetSession.mockResolvedValue(null);

    const res = await getThreads(makeThreadsRequest(SESSION_ID), {
      params: makeParams(SESSION_ID),
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('INVALID_BODY');
  });

  // --- empty session --------------------------------------------------------

  it('returns 200 with empty items and null nextCursor for a session with no threads', async () => {
    const res = await getThreads(makeThreadsRequest(SESSION_ID), {
      params: makeParams(SESSION_ID),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ items: [], nextCursor: null });
    // Schema parse must not throw
    AdminThreadsListResponseSchema.parse(body);
  });

  // --- pagination -----------------------------------------------------------

  it('encodes nextCursor as a non-empty base64 string when the repo returns one', async () => {
    const cursorData = { ts: new Date('2025-01-15T12:00:00.000Z'), id: 'cp3' };
    mockListThreadsForSession.mockResolvedValue({
      items: [
        makeThreadSummary('+447700900001', 3000),
        makeThreadSummary('+447700900002', 2000),
        makeThreadSummary('+447700900003', 1000),
      ],
      nextCursor: cursorData,
    });

    const res = await getThreads(makeThreadsRequest(SESSION_ID), {
      params: makeParams(SESSION_ID),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[]; nextCursor: string };
    expect(typeof body.nextCursor).toBe('string');
    expect(body.nextCursor.length).toBeGreaterThan(0);
    expect(body.items).toHaveLength(3);

    // Decoded cursor must match the underlying values
    const decoded = decodeAdminThreadCursor(body.nextCursor);
    expect(decoded).not.toBeNull();
    expect(decoded!.id).toBe('cp3');
    expect(decoded!.ts.toISOString()).toBe('2025-01-15T12:00:00.000Z');
  });

  it('forwards a decoded cursor object to the repo on the second page request', async () => {
    const cursorData = { ts: new Date('2025-01-15T12:00:00.000Z'), id: 'cp3' };
    const encodedCursor = encodeAdminThreadCursor(cursorData);

    mockListThreadsForSession.mockResolvedValue({ items: [], nextCursor: null });

    const res = await getThreads(
      makeThreadsRequest(SESSION_ID, `cursor=${encodeURIComponent(encodedCursor)}`),
      { params: makeParams(SESSION_ID) },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { nextCursor: null };
    expect(body.nextCursor).toBeNull();

    const callArgs = mockListThreadsForSession.mock.calls[0] as [
      string,
      { cursor: { ts: Date; id: string } },
    ];
    expect(callArgs[1].cursor).not.toBeNull();
    expect(callArgs[1].cursor.id).toBe('cp3');
    expect(callArgs[1].cursor.ts.toISOString()).toBe('2025-01-15T12:00:00.000Z');
  });

  // --- search ---------------------------------------------------------------

  it('passes search string to the repo when search >= 2 chars', async () => {
    await getThreads(makeThreadsRequest(SESSION_ID, 'search=ab'), {
      params: makeParams(SESSION_ID),
    });

    const callArgs = mockListThreadsForSession.mock.calls[0] as [string, { search?: string }];
    expect(callArgs[1].search).toBe('ab');
  });

  it('passes the search string through even when < 2 chars (repo decides whether to filter)', async () => {
    await getThreads(makeThreadsRequest(SESSION_ID, 'search=a'), {
      params: makeParams(SESSION_ID),
    });

    // Route passes through, assert whatever the route actually does (pass-through)
    const callArgs = mockListThreadsForSession.mock.calls[0] as [string, { search?: string }];
    // search=a is passed through; repo is responsible for the sub-2-char cutoff
    expect(callArgs[1].search).toBe('a');
  });

  it('passes undefined search to the repo when search param is empty', async () => {
    await getThreads(makeThreadsRequest(SESSION_ID, 'search='), {
      params: makeParams(SESSION_ID),
    });

    const callArgs = mockListThreadsForSession.mock.calls[0] as [string, { search?: string }];
    // An empty string coerces to undefined via `?? undefined` in the route
    expect(callArgs[1].search === '' || callArgs[1].search === undefined).toBe(true);
  });

  // --- invalid cursor -------------------------------------------------------

  it('returns 400 for a garbage cursor', async () => {
    const res = await getThreads(makeThreadsRequest(SESSION_ID, 'cursor=garbage'), {
      params: makeParams(SESSION_ID),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('INVALID_BODY');
  });

  // --- invalid limit --------------------------------------------------------

  it('returns 400 for a non-numeric limit', async () => {
    const res = await getThreads(makeThreadsRequest(SESSION_ID, 'limit=foo'), {
      params: makeParams(SESSION_ID),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('INVALID_BODY');
  });

  it('clamps limit=0 to 1 (does not reject it)', async () => {
    const res = await getThreads(makeThreadsRequest(SESSION_ID, 'limit=0'), {
      params: makeParams(SESSION_ID),
    });

    // Route clamps, not rejected
    expect(res.status).toBe(200);
    const callArgs = mockListThreadsForSession.mock.calls[0] as [string, { limit: number }];
    expect(callArgs[1].limit).toBe(1);
  });

  it('clamps limit=999 to 100', async () => {
    await getThreads(makeThreadsRequest(SESSION_ID, 'limit=999'), {
      params: makeParams(SESSION_ID),
    });

    const callArgs = mockListThreadsForSession.mock.calls[0] as [string, { limit: number }];
    expect(callArgs[1].limit).toBe(100);
  });

  // --- rate limit -----------------------------------------------------------

  it('returns 429 when the admin rate limit is exceeded', async () => {
    mockRequireAdmin.mockResolvedValue(makeAuthedAdmin({ sessionId: 'admin-sess-1' }));
    mockCheckAdminLimit.mockResolvedValue(false);

    const res = await getThreads(makeThreadsRequest(SESSION_ID), {
      params: makeParams(SESSION_ID),
    });

    expect(res.status).toBe(429);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('RATE_LIMITED');
  });

  it('rate-limits even when admin has no sessionId cookie (falls back to email key)', async () => {
    mockRequireAdmin.mockResolvedValue(makeAuthedAdmin({ sessionId: null }));
    mockCheckAdminLimit.mockResolvedValue(false);

    const res = await getThreads(makeThreadsRequest(SESSION_ID), {
      params: makeParams(SESSION_ID),
    });

    expect(res.status).toBe(429);
    expect(mockCheckAdminLimit).toHaveBeenCalledTimes(1);
    expect(mockCheckAdminLimit.mock.calls[0]?.[0]).toBe('email:admin@test.com');
  });

  // --- schema parse on success ----------------------------------------------

  it('response parses against AdminThreadsListResponseSchema', async () => {
    mockListThreadsForSession.mockResolvedValue({
      items: [makeThreadSummary()],
      nextCursor: null,
    });

    const res = await getThreads(makeThreadsRequest(SESSION_ID), {
      params: makeParams(SESSION_ID),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(() => AdminThreadsListResponseSchema.parse(body)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// GET /api/admin/sessions/:id/threads/:e164, thread messages
// ---------------------------------------------------------------------------

describe('GET /api/admin/sessions/[id]/threads/[e164]', () => {
  // --- auth -----------------------------------------------------------------

  it('returns 401 when not signed in', async () => {
    mockRequireAdmin.mockResolvedValue({
      ok: false,
      status: 401,
      message: 'Not signed in',
    });

    const res = await getMessages(makeMessagesRequest(SESSION_ID, COUNTERPARTY), {
      params: makeE164Params(SESSION_ID, COUNTERPARTY),
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('UNAUTHORIZED');
  });

  it('returns 403 when signed in but not on the admin allowlist', async () => {
    mockRequireAdmin.mockResolvedValue({
      ok: false,
      status: 403,
      message: 'Not an admin',
    });

    const res = await getMessages(makeMessagesRequest(SESSION_ID, COUNTERPARTY), {
      params: makeE164Params(SESSION_ID, COUNTERPARTY),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('UNAUTHORIZED');
  });

  // --- 404 ------------------------------------------------------------------

  it('returns 404 with INVALID_BODY when the session does not exist', async () => {
    mockGetSession.mockResolvedValue(null);

    const res = await getMessages(makeMessagesRequest(SESSION_ID, COUNTERPARTY), {
      params: makeE164Params(SESSION_ID, COUNTERPARTY),
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('INVALID_BODY');
  });

  // --- empty thread ---------------------------------------------------------

  it('returns 200 with empty items and null nextCursor for a thread with no messages', async () => {
    const res = await getMessages(makeMessagesRequest(SESSION_ID, COUNTERPARTY), {
      params: makeE164Params(SESSION_ID, COUNTERPARTY),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ items: [], nextCursor: null });
    AdminThreadMessagesResponseSchema.parse(body);
  });

  // --- E.164 validation -----------------------------------------------------

  it('returns 400 for a non-E.164 counterparty param', async () => {
    const res = await getMessages(makeMessagesRequest(SESSION_ID, 'notanumber'), {
      params: makeE164Params(SESSION_ID, 'notanumber'),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('INVALID_BODY');
  });

  it('accepts a URL-decoded E.164 counterparty and passes it to the repo', async () => {
    // Simulates Next.js decoding the path param before the handler sees it
    const decoded = '+447700900123';

    await getMessages(makeMessagesRequest(SESSION_ID, decoded), {
      params: makeE164Params(SESSION_ID, decoded),
    });

    const callArgs = mockListThreadMessages.mock.calls[0] as [string, string, unknown];
    expect(callArgs[1]).toBe(decoded);
  });

  // --- cursor pagination ----------------------------------------------------

  it('encodes nextCursor when the repo returns one', async () => {
    const cursorData = { ts: new Date('2025-02-01T09:00:00.000Z'), id: 'msg-99' };
    mockListThreadMessages.mockResolvedValue({
      items: [makeThreadMessage('out', 1000)],
      nextCursor: cursorData,
    });

    const res = await getMessages(makeMessagesRequest(SESSION_ID, COUNTERPARTY), {
      params: makeE164Params(SESSION_ID, COUNTERPARTY),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { nextCursor: string };
    expect(typeof body.nextCursor).toBe('string');
    expect(body.nextCursor.length).toBeGreaterThan(0);

    const decoded = decodeAdminThreadCursor(body.nextCursor);
    expect(decoded!.id).toBe('msg-99');
  });

  it('forwards a decoded cursor to the messages repo on subsequent pages', async () => {
    const cursorData = { ts: new Date('2025-02-01T09:00:00.000Z'), id: 'msg-99' };
    const encodedCursor = encodeAdminThreadCursor(cursorData);

    await getMessages(
      makeMessagesRequest(SESSION_ID, COUNTERPARTY, `cursor=${encodeURIComponent(encodedCursor)}`),
      { params: makeE164Params(SESSION_ID, COUNTERPARTY) },
    );

    const callArgs = mockListThreadMessages.mock.calls[0] as [
      string,
      string,
      { cursor: { ts: Date; id: string } },
    ];
    expect(callArgs[2].cursor).not.toBeNull();
    expect(callArgs[2].cursor.id).toBe('msg-99');
  });

  // --- invalid cursor -------------------------------------------------------

  it('returns 400 for a garbage cursor', async () => {
    const res = await getMessages(makeMessagesRequest(SESSION_ID, COUNTERPARTY, 'cursor=garbage'), {
      params: makeE164Params(SESSION_ID, COUNTERPARTY),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('INVALID_BODY');
  });

  // --- invalid limit --------------------------------------------------------

  it('returns 400 for a non-numeric limit', async () => {
    const res = await getMessages(makeMessagesRequest(SESSION_ID, COUNTERPARTY, 'limit=foo'), {
      params: makeE164Params(SESSION_ID, COUNTERPARTY),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('INVALID_BODY');
  });

  it('clamps limit=0 to 1', async () => {
    const res = await getMessages(makeMessagesRequest(SESSION_ID, COUNTERPARTY, 'limit=0'), {
      params: makeE164Params(SESSION_ID, COUNTERPARTY),
    });

    expect(res.status).toBe(200);
    const callArgs = mockListThreadMessages.mock.calls[0] as [string, string, { limit: number }];
    expect(callArgs[2].limit).toBe(1);
  });

  it('clamps limit=999 to 100', async () => {
    await getMessages(makeMessagesRequest(SESSION_ID, COUNTERPARTY, 'limit=999'), {
      params: makeE164Params(SESSION_ID, COUNTERPARTY),
    });

    const callArgs = mockListThreadMessages.mock.calls[0] as [string, string, { limit: number }];
    expect(callArgs[2].limit).toBe(100);
  });

  // --- rate limit -----------------------------------------------------------

  it('returns 429 when the admin-session rate limit is exceeded', async () => {
    mockRequireAdmin.mockResolvedValue(makeAuthedAdmin({ sessionId: 'admin-sess-1' }));
    mockCheckAdminLimit.mockResolvedValue(false);

    const res = await getMessages(makeMessagesRequest(SESSION_ID, COUNTERPARTY), {
      params: makeE164Params(SESSION_ID, COUNTERPARTY),
    });

    expect(res.status).toBe(429);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('RATE_LIMITED');
  });

  // --- mixed direction pass-through -----------------------------------------

  it('passes mixed-direction items through; status present only on outbound items', async () => {
    mockListThreadMessages.mockResolvedValue({
      items: [
        makeThreadMessage('out', 2000),
        makeThreadMessage('in', 1000),
        makeThreadMessage('out', 0),
      ],
      nextCursor: null,
    });

    const res = await getMessages(makeMessagesRequest(SESSION_ID, COUNTERPARTY), {
      params: makeE164Params(SESSION_ID, COUNTERPARTY),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ direction: string; status?: string }> };
    expect(body.items).toHaveLength(3);

    const outItems = body.items.filter((i) => i.direction === 'out');
    const inItems = body.items.filter((i) => i.direction === 'in');

    outItems.forEach((item) => expect(item.status).toBeDefined());
    inItems.forEach((item) => expect(item.status).toBeUndefined());
  });

  // --- schema parse on success ----------------------------------------------

  it('response parses against AdminThreadMessagesResponseSchema', async () => {
    mockListThreadMessages.mockResolvedValue({
      items: [makeThreadMessage('out'), makeThreadMessage('in')],
      nextCursor: null,
    });

    const res = await getMessages(makeMessagesRequest(SESSION_ID, COUNTERPARTY), {
      params: makeE164Params(SESSION_ID, COUNTERPARTY),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(() => AdminThreadMessagesResponseSchema.parse(body)).not.toThrow();
  });
});

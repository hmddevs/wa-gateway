/**
 * GET /api/admin/sessions/:id/contacts, contacts viewer behaviour.
 *
 * Covers the admin contacts endpoint added in slice 4. Reads from the new
 * `contacts` collection via `listContactsForSession` (replace-on-conflict
 * repo). Sorting is done in-memory by the repo, not tested here, that is
 * the repo's unit concern. Route tests focus on HTTP shape, auth, session
 * gating, and cross-session isolation.
 *
 * Mocked boundaries:
 *   - @/lib/require-admin
 *   - @/lib/repositories/sessions, getSession
 *   - @/lib/repositories/contacts, listContactsForSession
 *   - @/lib/admin-rate-limit, checkAdminLimit, adminLimiterKey
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

vi.mock('@/lib/repositories/contacts', () => ({
  listContactsForSession: vi.fn(),
}));

vi.mock('@/lib/admin-rate-limit', () => ({
  adminLimiterKey: vi.fn(() => 'sess:admin-sess-1'),
  checkAdminLimit: vi.fn().mockResolvedValue(true),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/request-id', () => ({
  mintRequestId: vi.fn(() => 'req-test'),
}));

// ---- imports after mocks ----------------------------------------------------

import { GET } from '@/app/api/admin/sessions/[id]/contacts/route';
import { requireAdmin } from '@/lib/require-admin';
import { getSession } from '@/lib/repositories/sessions';
import { listContactsForSession } from '@/lib/repositories/contacts';
import type { ContactDoc } from '@hmddevs/protocol';

// ---------------------------------------------------------------------------
// Typed mock references
// ---------------------------------------------------------------------------

const mockRequireAdmin = requireAdmin as ReturnType<typeof vi.fn>;
const mockGetSession = getSession as ReturnType<typeof vi.fn>;
const mockListContactsForSession = listContactsForSession as ReturnType<typeof vi.fn>;

const SESSION_ID = 'session-a';
const OTHER_SESSION_ID = 'session-b';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAdminContext() {
  return {
    ok: true as const,
    admin: { email: 'admin@test.com', sessionId: 'admin-sess-1', webauthnFreshAt: null },
  };
}

function makeSession(id = SESSION_ID) {
  return {
    sessionId: id,
    workerId: 'worker-1',
    label: 'Test',
    status: 'connected',
    phoneE164: '+447700900000',
  };
}

function makeContact(overrides: Partial<ContactDoc> = {}): ContactDoc {
  return {
    sessionId: SESSION_ID,
    e164: '+447700900001',
    waJid: '447700900001@s.whatsapp.net',
    isBusiness: false,
    capturedAt: new Date().toISOString(),
    source: 'live',
    ...overrides,
  };
}

function makeParams(id: string): Promise<{ id: string }> {
  return Promise.resolve({ id });
}

function makeGetRequest(sessionId: string): Request {
  return new Request(`https://wa.test/api/admin/sessions/${sessionId}/contacts`, {
    method: 'GET',
  });
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  // why: re-pin every mock, Vitest's clearAllMocks can reset factory defaults
  // on some configurations. See chat-event.test.ts comments for rationale.
  mockRequireAdmin.mockResolvedValue(makeAdminContext());
  mockGetSession.mockResolvedValue(makeSession());
  mockListContactsForSession.mockResolvedValue([]);
});

// ---------------------------------------------------------------------------
// Empty contacts
// ---------------------------------------------------------------------------

describe('contacts_route, empty session returns contacts: []', () => {
  it('returns 200 with an empty contacts array', async () => {
    const res = await GET(makeGetRequest(SESSION_ID), { params: makeParams(SESSION_ID) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { contacts: unknown[] };
    expect(body.contacts).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Populated contacts
// ---------------------------------------------------------------------------

describe('contacts_route, populated session returns all contacts', () => {
  it('returns 200 with the seeded contacts', async () => {
    const contacts = [
      makeContact({ e164: '+447700900001', displayName: 'Alice' }),
      makeContact({ e164: '+447700900002', displayName: 'Bob' }),
      makeContact({ e164: '+447700900003', displayName: 'Carol' }),
    ];
    mockListContactsForSession.mockResolvedValueOnce(contacts);

    const res = await GET(makeGetRequest(SESSION_ID), { params: makeParams(SESSION_ID) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { contacts: ContactDoc[] };
    expect(body.contacts).toHaveLength(3);
    const e164s = body.contacts.map((c) => c.e164);
    expect(e164s).toContain('+447700900001');
    expect(e164s).toContain('+447700900002');
    expect(e164s).toContain('+447700900003');
  });
});

// ---------------------------------------------------------------------------
// Auth, unauthenticated request
// ---------------------------------------------------------------------------

describe('contacts_route, auth: unauthenticated request', () => {
  it('returns 401 when requireAdmin fails', async () => {
    mockRequireAdmin.mockResolvedValueOnce({ ok: false, status: 401, message: 'Not signed in' });
    const res = await GET(makeGetRequest(SESSION_ID), { params: makeParams(SESSION_ID) });
    expect(res.status).toBe(401);
    expect(mockListContactsForSession).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Session not found
// ---------------------------------------------------------------------------

describe('contacts_route, session not found', () => {
  it('returns 404 when the session does not exist', async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const res = await GET(makeGetRequest(SESSION_ID), { params: makeParams(SESSION_ID) });
    expect(res.status).toBe(404);
    expect(mockListContactsForSession).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Cross-session isolation
// ---------------------------------------------------------------------------

describe('contacts_route, cross-session isolation', () => {
  it('calls listContactsForSession with the requested session id only', async () => {
    const sessionAContacts = [makeContact({ sessionId: SESSION_ID, e164: '+447700900010' })];
    // Session B contacts would be returned if isolation broke, set up mock to
    // serve session A with its own data.
    mockListContactsForSession.mockResolvedValueOnce(sessionAContacts);

    const res = await GET(makeGetRequest(SESSION_ID), { params: makeParams(SESSION_ID) });
    expect(res.status).toBe(200);

    // Verify the repo was called with the correct session id.
    expect(mockListContactsForSession).toHaveBeenCalledWith(SESSION_ID);

    // Verify that the OTHER_SESSION_ID was not used.
    const calledWith = (mockListContactsForSession.mock.calls[0] as [string])[0];
    expect(calledWith).not.toBe(OTHER_SESSION_ID);
  });
});

// ---------------------------------------------------------------------------
// Pagination: route passes no limit/offset (not exposed). Skip per brief.
// ---------------------------------------------------------------------------

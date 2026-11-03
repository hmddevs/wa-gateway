/**
 * Admin conversation viewer, group messages route tests.
 *
 * GET /api/admin/sessions/:id/threads/groups/:b64jid/messages
 *
 * Mocked boundaries:
 *   - @/lib/require-admin
 *   - @/lib/repositories/sessions, getSession
 *   - @/lib/repositories/messages, listGroupMessages
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
  listGroupMessages: vi.fn(),
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

import { GET } from '@/app/api/admin/sessions/[id]/threads/groups/[b64jid]/messages/route';
import { requireAdmin } from '@/lib/require-admin';
import { getSession } from '@/lib/repositories/sessions';
import { listGroupMessages } from '@/lib/repositories/messages';
import { checkAdminLimit } from '@/lib/admin-rate-limit';
import type { SessionDoc } from '@/lib/repositories/sessions';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockRequireAdmin = requireAdmin as ReturnType<typeof vi.fn>;
const mockGetSession = getSession as ReturnType<typeof vi.fn>;
const mockListGroupMessages = listGroupMessages as ReturnType<typeof vi.fn>;
const mockCheckAdminLimit = checkAdminLimit as ReturnType<typeof vi.fn>;

const SESSION_ID = 'session-abc';
const GROUP_JID = '120363000000000@g.us';
const GROUP_B64 = Buffer.from(GROUP_JID).toString('base64url');

function makeAuthedAdmin() {
  return {
    ok: true as const,
    admin: { email: 'admin@test.com', sessionId: null, webauthnFreshAt: null },
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

function makeGroupMessage(direction: 'in' | 'out' = 'in') {
  return {
    messageId: `waid-${Math.random().toString(36).slice(2)}`,
    direction,
    ts: new Date(),
    body: { kind: 'text' as const, text: 'Hello group' },
  };
}

function makeRequest(sessionId: string, b64jid: string, qs = ''): Request {
  return new Request(
    `https://wa.test/api/admin/sessions/${sessionId}/threads/groups/${b64jid}/messages${qs ? `?${qs}` : ''}`,
    { method: 'GET' },
  );
}

function makeCtx(sessionId: string, b64jid: string) {
  return { params: Promise.resolve({ id: sessionId, b64jid }) };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAdmin.mockResolvedValue(makeAuthedAdmin());
  mockGetSession.mockResolvedValue(makeSession());
  mockCheckAdminLimit.mockResolvedValue(true);
  mockListGroupMessages.mockResolvedValue({ items: [], nextCursor: null });
});

// ---------------------------------------------------------------------------
// Auth gate
// ---------------------------------------------------------------------------

describe('GET /threads/groups/:b64jid/messages, auth', () => {
  it('returns 401 when requireAdmin fails', async () => {
    mockRequireAdmin.mockResolvedValue({ ok: false, status: 401, message: 'Unauthorized' });

    const res = await GET(makeRequest(SESSION_ID, GROUP_B64), makeCtx(SESSION_ID, GROUP_B64));

    expect(res.status).toBe(401);
  });

  it('returns 429 when rate limit exceeded', async () => {
    mockCheckAdminLimit.mockResolvedValue(false);

    const res = await GET(makeRequest(SESSION_ID, GROUP_B64), makeCtx(SESSION_ID, GROUP_B64));

    expect(res.status).toBe(429);
  });
});

// ---------------------------------------------------------------------------
// JID validation
// ---------------------------------------------------------------------------

describe('GET /threads/groups/:b64jid/messages, JID validation', () => {
  it('returns 400 when b64jid decodes to a non-group JID', async () => {
    const nonGroup = Buffer.from('notagroup@s.whatsapp.net').toString('base64url');

    const res = await GET(makeRequest(SESSION_ID, nonGroup), makeCtx(SESSION_ID, nonGroup));

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/invalid group id/i);
  });

  it('returns 400 when b64jid is not valid base64', async () => {
    const garbage = '!!!not-base64!!!';

    const res = await GET(makeRequest(SESSION_ID, garbage), makeCtx(SESSION_ID, garbage));

    expect(res.status).toBe(400);
  });

  it('returns 400 when b64jid decodes to an empty string', async () => {
    const empty = Buffer.from('').toString('base64url');

    const res = await GET(makeRequest(SESSION_ID, empty), makeCtx(SESSION_ID, empty));

    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('GET /threads/groups/:b64jid/messages, happy path', () => {
  it('returns 200 with items for a valid group JID', async () => {
    const msg = makeGroupMessage('in');
    mockListGroupMessages.mockResolvedValue({ items: [msg], nextCursor: null });

    const res = await GET(makeRequest(SESSION_ID, GROUP_B64), makeCtx(SESSION_ID, GROUP_B64));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[]; nextCursor: unknown };
    expect(body.items).toHaveLength(1);
    expect((body.items[0] as { messageId: string }).messageId).toBe(msg.messageId);
    expect(body.nextCursor).toBeNull();
  });

  it('calls listGroupMessages with the correct sessionId and counterpartyJid', async () => {
    await GET(makeRequest(SESSION_ID, GROUP_B64), makeCtx(SESSION_ID, GROUP_B64));

    expect(mockListGroupMessages).toHaveBeenCalledOnce();
    const [sid, jid] = mockListGroupMessages.mock.calls[0] as [string, string];
    expect(sid).toBe(SESSION_ID);
    expect(jid).toBe(GROUP_JID);
  });

  it('passes limit query param to listGroupMessages', async () => {
    await GET(makeRequest(SESSION_ID, GROUP_B64, 'limit=10'), makeCtx(SESSION_ID, GROUP_B64));

    const [, , opts] = mockListGroupMessages.mock.calls[0] as [string, string, { limit: number }];
    expect(opts.limit).toBe(10);
  });

  it('returns 404 when session does not exist', async () => {
    mockGetSession.mockResolvedValue(null);

    const res = await GET(makeRequest(SESSION_ID, GROUP_B64), makeCtx(SESSION_ID, GROUP_B64));

    expect(res.status).toBe(404);
  });
});

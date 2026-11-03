/**
 * POST /api/admin/sessions/:id/send, project/purpose metadata.
 *
 * Covers the additional requirements introduced by the project-purpose gate:
 *   - Body schema requires `purpose`; missing → 400
 *   - Persisted `MessageDoc.projectId === 'admin-console'` sentinel
 *   - Wire envelope carries `projectId` and `purpose`
 *
 * Mocked boundaries, same set as send.route.test.ts in this directory.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- module mocks -----------------------------------------------------------

vi.mock('@/lib/require-admin', () => ({
  requireAdmin: vi.fn(),
}));

vi.mock('@/lib/admin-rate-limit', () => ({
  adminLimiterKey: vi.fn(() => 'sess:session-1'),
  checkAdminLimit: vi.fn(async () => true),
}));

vi.mock('@/lib/repositories/sessions', () => ({
  getSession: vi.fn(),
  getCachedSession: vi.fn(),
}));

vi.mock('@/lib/repositories/messages', () => ({
  insertMessage: vi.fn(async () => {}),
  findReplyTarget: vi.fn(async () => null),
}));

vi.mock('@/lib/repositories/optouts', () => ({
  isOptedOut: vi.fn(async () => false),
}));

vi.mock('@/lib/repositories/audit', () => ({
  appendAudit: vi.fn(async () => {}),
}));

vi.mock('@/lib/redis', () => ({
  getRedis: vi.fn(() => ({
    multi: vi.fn(() => ({
      lpush: vi.fn().mockReturnThis(),
      publish: vi.fn().mockReturnThis(),
      exec: vi.fn(async () => []),
    })),
  })),
}));

vi.mock('@/lib/wire', () => ({
  channels: {
    pending: (id: string) => `wa:pending:${id}`,
    outbound: (id: string) => `wa:outbound:${id}`,
  },
  sign: vi.fn(async (e: unknown) => e),
  newNonce: vi.fn(() => 'test-nonce'),
  nowIso: vi.fn(() => new Date().toISOString()),
}));

vi.mock('@/lib/phone', () => ({
  normalisePhone: vi.fn((p: string) => (p.startsWith('+') ? p : null)),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/request-id', () => ({
  mintRequestId: vi.fn(() => 'req-test'),
}));

// ---- imports after mocks ----------------------------------------------------

import { POST } from '@/app/api/admin/sessions/[id]/send/route';
import { requireAdmin } from '@/lib/require-admin';
import { getSession } from '@/lib/repositories/sessions';
import { insertMessage } from '@/lib/repositories/messages';
import { sign } from '@/lib/wire';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockRequireAdmin = requireAdmin as ReturnType<typeof vi.fn>;
const mockGetSession = getSession as ReturnType<typeof vi.fn>;
const mockInsertMessage = insertMessage as ReturnType<typeof vi.fn>;
const mockSign = sign as ReturnType<typeof vi.fn>;

const SESSION_ID = 'session-1';

function makeReq(body: unknown, sessionId = SESSION_ID): Request {
  return new Request(`http://localhost/api/admin/sessions/${sessionId}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function makeCtx(id = SESSION_ID) {
  return { params: Promise.resolve({ id }) };
}

function makeAuthedAdmin() {
  return {
    ok: true as const,
    admin: {
      email: 'admin@hmd.test',
      sessionId: 'admin-sess-1',
      webauthnFreshAt: new Date(),
    },
  };
}

function makeConnectedSession() {
  return { sessionId: SESSION_ID, workerId: 'worker-1', status: 'connected' };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAdmin.mockResolvedValue(makeAuthedAdmin());
  mockGetSession.mockResolvedValue(makeConnectedSession());
  mockInsertMessage.mockResolvedValue(undefined);
  mockSign.mockImplementation(async (e: unknown) => e);
});

// ---------------------------------------------------------------------------
// purpose, required on admin send
// ---------------------------------------------------------------------------

describe("POST /api/admin/sessions/:id/send, 'purpose' required", () => {
  it('returns 400 INVALID_BODY when purpose is absent from the body', async () => {
    const res = await POST(
      makeReq({ to: '+447700900123', body: { kind: 'text', text: 'hi' } }),
      makeCtx(),
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { code: string };
    expect(json.code).toBe('INVALID_BODY');
  });

  it('returns 400 INVALID_BODY when purpose is an unknown value', async () => {
    const res = await POST(
      makeReq({ to: '+447700900123', body: { kind: 'text', text: 'hi' }, purpose: 'spam' }),
      makeCtx(),
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { code: string };
    expect(json.code).toBe('INVALID_BODY');
  });
});

// ---------------------------------------------------------------------------
// admin-console sentinel projectId
// ---------------------------------------------------------------------------

describe("POST /api/admin/sessions/:id/send, 'admin-console' sentinel projectId", () => {
  it("persisted MessageDoc.projectId is 'admin-console' regardless of body contents", async () => {
    await POST(
      makeReq({ to: '+447700900123', body: { kind: 'text', text: 'hi' }, purpose: 'support' }),
      makeCtx(),
    );

    expect(mockInsertMessage).toHaveBeenCalledOnce();
    const doc = mockInsertMessage.mock.calls[0]![0] as Record<string, unknown>;
    expect(doc.projectId).toBe('admin-console');
  });

  it('wire envelope carries projectId: admin-console and the supplied purpose', async () => {
    await POST(
      makeReq({ to: '+447700900123', body: { kind: 'text', text: 'hi' }, purpose: 'support' }),
      makeCtx(),
    );

    expect(mockSign).toHaveBeenCalledOnce();
    const envelope = mockSign.mock.calls[0]![0] as Record<string, unknown>;
    expect(envelope.projectId).toBe('admin-console');
    expect(envelope.purpose).toBe('support');
  });
});

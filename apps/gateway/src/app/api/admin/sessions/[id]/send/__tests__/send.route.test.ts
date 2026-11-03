/**
 * Admin send route handler tests.
 *
 * POST /api/admin/sessions/:id/send
 *
 * Mocked boundaries:
 *   - @/lib/require-admin
 *   - @/lib/admin-rate-limit, checkAdminLimit + adminLimiterKey
 *   - @/lib/repositories/sessions, getSession
 *   - @/lib/repositories/messages, insertMessage, findReplyTarget
 *   - @/lib/repositories/optouts, isOptedOut
 *   - @/lib/repositories/audit, appendAudit
 *   - @/lib/redis, getRedis
 *   - @/lib/wire, channels, sign, newNonce, nowIso
 *   - @/lib/phone, normalisePhone
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- module mocks -----------------------------------------------------------

vi.mock('@/lib/require-admin', () => ({
  requireAdmin: vi.fn(),
}));

vi.mock('@/lib/admin-rate-limit', () => ({
  adminLimiterKey: vi.fn(() => 'sess:test-session'),
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
import { checkAdminLimit } from '@/lib/admin-rate-limit';
import { getSession } from '@/lib/repositories/sessions';
import { insertMessage, findReplyTarget } from '@/lib/repositories/messages';
import { isOptedOut } from '@/lib/repositories/optouts';
import { sign } from '@/lib/wire';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockRequireAdmin = requireAdmin as ReturnType<typeof vi.fn>;
const mockCheckAdminLimit = checkAdminLimit as ReturnType<typeof vi.fn>;
const mockGetSession = getSession as ReturnType<typeof vi.fn>;
const mockInsertMessage = insertMessage as ReturnType<typeof vi.fn>;
const mockFindReplyTarget = findReplyTarget as ReturnType<typeof vi.fn>;
const mockIsOptedOut = isOptedOut as ReturnType<typeof vi.fn>;
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
  mockCheckAdminLimit.mockResolvedValue(true);
  mockGetSession.mockResolvedValue(makeConnectedSession());
  mockIsOptedOut.mockResolvedValue(false);
  mockInsertMessage.mockResolvedValue(undefined);
  mockFindReplyTarget.mockResolvedValue(null);
  mockSign.mockImplementation(async (e: unknown) => e);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/admin/sessions/:id/send', () => {
  // --- auth -----------------------------------------------------------------

  it('returns 401 when requireAdmin returns ok:false with status 401', async () => {
    mockRequireAdmin.mockResolvedValue({
      ok: false,
      status: 401,
      message: 'Not signed in',
    });

    const res = await POST(
      makeReq({ to: '+447700900123', body: { kind: 'text', text: 'hi' } }),
      makeCtx(),
    );

    expect(res.status).toBe(401);
    const data = (await res.json()) as { code: string };
    expect(data.code).toBe('UNAUTHORIZED');
  });

  it('returns 403 when WebAuthn step-up is required', async () => {
    mockRequireAdmin.mockResolvedValue({
      ok: false,
      status: 403,
      message: 'WebAuthn step-up required',
    });

    const res = await POST(
      makeReq({ to: '+447700900123', body: { kind: 'text', text: 'hi' } }),
      makeCtx(),
    );

    expect(res.status).toBe(403);
    const data = (await res.json()) as { code: string; error: string };
    expect(data.code).toBe('UNAUTHORIZED');
    expect(data.error).toBe('WebAuthn step-up required');
  });

  // --- validation -----------------------------------------------------------

  it('returns 400 for an invalid session id', async () => {
    const res = await POST(
      makeReq({ to: '+447700900123', body: { kind: 'text', text: 'hi' } }, 'INVALID ID'),
      makeCtx('INVALID ID'),
    );

    expect(res.status).toBe(400);
    const data = (await res.json()) as { code: string };
    expect(data.code).toBe('INVALID_BODY');
  });

  it('returns 429 when checkAdminLimit returns false', async () => {
    mockCheckAdminLimit.mockResolvedValue(false);

    const res = await POST(
      makeReq({ to: '+447700900123', body: { kind: 'text', text: 'hi' } }),
      makeCtx(),
    );

    expect(res.status).toBe(429);
    const data = (await res.json()) as { code: string };
    expect(data.code).toBe('RATE_LIMITED');
  });

  it('returns 400 for malformed JSON body', async () => {
    const req = new Request(`http://localhost/api/admin/sessions/${SESSION_ID}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json {{',
    });

    const res = await POST(req, makeCtx());

    expect(res.status).toBe(400);
    const data = (await res.json()) as { code: string };
    expect(data.code).toBe('INVALID_BODY');
  });

  it('returns 400 when the `to` field is missing', async () => {
    const res = await POST(
      makeReq({ body: { kind: 'text', text: 'hi' }, purpose: 'otp' }),
      makeCtx(),
    );

    expect(res.status).toBe(400);
    const data = (await res.json()) as { code: string };
    expect(data.code).toBe('INVALID_BODY');
  });

  it('returns 400 when the phone number is neither E.164 nor a group JID', async () => {
    const res = await POST(
      makeReq({ to: 'not-a-phone', body: { kind: 'text', text: 'hi' }, purpose: 'otp' }),
      makeCtx(),
    );

    expect(res.status).toBe(400);
    const data = (await res.json()) as { code: string };
    expect(data.code).toBe('INVALID_BODY');
  });

  it('returns 404 when getSession returns null', async () => {
    mockGetSession.mockResolvedValue(null);

    const res = await POST(
      makeReq({ to: '+447700900123', body: { kind: 'text', text: 'hi' }, purpose: 'otp' }),
      makeCtx(),
    );

    expect(res.status).toBe(404);
    const data = (await res.json()) as { code: string };
    expect(data.code).toBe('INVALID_BODY');
  });

  it('returns 503 when session status is not connected (pairing)', async () => {
    mockGetSession.mockResolvedValue({
      sessionId: SESSION_ID,
      workerId: 'worker-1',
      status: 'pairing',
    });

    const res = await POST(
      makeReq({ to: '+447700900123', body: { kind: 'text', text: 'hi' }, purpose: 'otp' }),
      makeCtx(),
    );

    expect(res.status).toBe(503);
    const data = (await res.json()) as { code: string };
    expect(data.code).toBe('WORKER_UNAVAILABLE');
  });

  // --- opt-out --------------------------------------------------------------

  it('returns 422 with OPTED_OUT when recipient has opted out', async () => {
    mockIsOptedOut.mockResolvedValue(true);

    const res = await POST(
      makeReq({ to: '+447700900123', body: { kind: 'text', text: 'hi' }, purpose: 'otp' }),
      makeCtx(),
    );

    expect(res.status).toBe(422);
    const data = (await res.json()) as { code: string };
    expect(data.code).toBe('OPTED_OUT');
  });

  // --- happy path -----------------------------------------------------------

  it('returns 201 with messageId and status queued for a valid text send', async () => {
    const res = await POST(
      makeReq({ to: '+447700900123', body: { kind: 'text', text: 'hello world' }, purpose: 'otp' }),
      makeCtx(),
    );

    expect(res.status).toBe(201);
    const data = (await res.json()) as { messageId: string; status: string };
    expect(typeof data.messageId).toBe('string');
    expect(data.messageId.length).toBeGreaterThan(0);
    expect(data.status).toBe('queued');
  });

  it('returns 201 and passes quoted to sign when findReplyTarget resolves a message', async () => {
    mockFindReplyTarget.mockResolvedValue({ waMessageId: 'wa-abc', fromMe: true });

    const res = await POST(
      makeReq({
        to: '+447700900123',
        body: { kind: 'text', text: 'replying' },
        purpose: 'otp',
        replyTo: { messageId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' },
      }),
      makeCtx(),
    );

    expect(res.status).toBe(201);

    expect(mockSign).toHaveBeenCalledTimes(1);
    const envelopeArg = mockSign.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(envelopeArg.quoted).toEqual({ waMessageId: 'wa-abc', fromMe: true });
  });

  // --- group JID ------------------------------------------------------------

  it('returns 201 for a valid group JID (v2 format)', async () => {
    const res = await POST(
      makeReq({
        to: '120363048888888888@g.us',
        body: { kind: 'text', text: 'hello group' },
        purpose: 'otp',
      }),
      makeCtx(),
    );

    expect(res.status).toBe(201);
    const data = (await res.json()) as { status: string };
    expect(data.status).toBe('queued');
  });

  it('does not call isOptedOut for a group JID', async () => {
    await POST(
      makeReq({
        to: '120363048888888888@g.us',
        body: { kind: 'text', text: 'hello group' },
        purpose: 'otp',
      }),
      makeCtx(),
    );

    expect(mockIsOptedOut).not.toHaveBeenCalled();
  });

  it('returns 400 for an invalid `to` that is neither E.164 nor group JID', async () => {
    const res = await POST(
      makeReq({ to: 'not-valid@example.com', body: { kind: 'text', text: 'hi' }, purpose: 'otp' }),
      makeCtx(),
    );

    expect(res.status).toBe(400);
    const data = (await res.json()) as { code: string };
    expect(data.code).toBe('INVALID_BODY');
  });

  // --- reply target ---------------------------------------------------------

  it('returns 404 when replyTo.messageId is provided but findReplyTarget returns null', async () => {
    mockFindReplyTarget.mockResolvedValue(null);

    const res = await POST(
      makeReq({
        to: '+447700900123',
        body: { kind: 'text', text: 'hello' },
        purpose: 'otp',
        replyTo: { messageId: 'deadbeef-dead-beef-dead-beefdeadbeef' },
      }),
      makeCtx(),
    );

    expect(res.status).toBe(404);
    const data = (await res.json()) as { code: string };
    expect(data.code).toBe('RECIPIENT_NOT_FOUND');
  });
});

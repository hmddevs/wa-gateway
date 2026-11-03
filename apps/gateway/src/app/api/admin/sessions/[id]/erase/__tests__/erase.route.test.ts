/**
 * Admin erasure route handler tests.
 *
 * POST /api/admin/sessions/:id/erase
 *
 * Mocked boundaries:
 *   - @/lib/require-admin
 *   - @/lib/repositories/sessions, getSession
 *   - @/lib/repositories/erasure, eraseContact
 *   - @/lib/repositories/audit, appendAudit
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/require-admin', () => ({
  requireAdmin: vi.fn(),
}));

vi.mock('@/lib/repositories/sessions', () => ({
  getSession: vi.fn(),
}));

vi.mock('@/lib/repositories/erasure', () => ({
  eraseContact: vi.fn(),
}));

vi.mock('@/lib/repositories/audit', () => ({
  appendAudit: vi.fn(async () => {}),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/request-id', () => ({
  mintRequestId: vi.fn(() => 'req-test'),
}));

import { POST } from '@/app/api/admin/sessions/[id]/erase/route';
import { requireAdmin } from '@/lib/require-admin';
import { getSession } from '@/lib/repositories/sessions';
import { eraseContact } from '@/lib/repositories/erasure';

const mockRequireAdmin = requireAdmin as ReturnType<typeof vi.fn>;
const mockGetSession = getSession as ReturnType<typeof vi.fn>;
const mockEraseContact = eraseContact as ReturnType<typeof vi.fn>;

const SESSION_ID = 'session-1';
const PHONE = '+447700900123';

function makeReq(body: unknown): Request {
  return new Request(`http://localhost/api/admin/sessions/${SESSION_ID}/erase`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function makeCtx() {
  return { params: Promise.resolve({ id: SESSION_ID }) };
}

function makeAuthedAdmin() {
  return {
    ok: true as const,
    admin: { email: 'admin@hmd.test', sessionId: 'admin-sess-1', webauthnFreshAt: new Date() },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAdmin.mockResolvedValue(makeAuthedAdmin());
  mockGetSession.mockResolvedValue({ sessionId: SESSION_ID, workerId: 'worker-1' });
  mockEraseContact.mockResolvedValue({ messages: 3, contacts: 1 });
});

describe('POST /api/admin/sessions/:id/erase', () => {
  it('returns 401 when requireAdmin returns ok:false, without calling eraseContact', async () => {
    mockRequireAdmin.mockResolvedValue({ ok: false, status: 401, message: 'Not signed in' });

    const res = await POST(makeReq({ phone: PHONE, confirm: true }), makeCtx());

    expect(res.status).toBe(401);
    const data = (await res.json()) as { code: string };
    expect(data.code).toBe('UNAUTHORIZED');
    expect(mockEraseContact).not.toHaveBeenCalled();
  });

  it('returns 403 when WebAuthn step-up is required, without calling eraseContact', async () => {
    mockRequireAdmin.mockResolvedValue({
      ok: false,
      status: 403,
      message: 'WebAuthn step-up required',
    });

    const res = await POST(makeReq({ phone: PHONE, confirm: true }), makeCtx());

    expect(res.status).toBe(403);
    expect(mockEraseContact).not.toHaveBeenCalled();
  });

  it('returns 400 when confirm is not true', async () => {
    const res = await POST(makeReq({ phone: PHONE, confirm: false }), makeCtx());

    expect(res.status).toBe(400);
    const data = (await res.json()) as { code: string };
    expect(data.code).toBe('INVALID_BODY');
    expect(mockEraseContact).not.toHaveBeenCalled();
  });

  it('returns 400 when confirm is missing', async () => {
    const res = await POST(makeReq({ phone: PHONE }), makeCtx());

    expect(res.status).toBe(400);
    const data = (await res.json()) as { code: string };
    expect(data.code).toBe('INVALID_BODY');
    expect(mockEraseContact).not.toHaveBeenCalled();
  });

  it('returns 400 when phone is not E.164', async () => {
    const res = await POST(makeReq({ phone: '0770 900123', confirm: true }), makeCtx());

    expect(res.status).toBe(400);
    const data = (await res.json()) as { code: string };
    expect(data.code).toBe('INVALID_BODY');
    expect(mockEraseContact).not.toHaveBeenCalled();
  });

  it('calls eraseContact with the session id and phone, and returns 200', async () => {
    const res = await POST(makeReq({ phone: PHONE, confirm: true }), makeCtx());

    expect(res.status).toBe(200);
    expect(mockEraseContact).toHaveBeenCalledWith(SESSION_ID, PHONE);
    const data = (await res.json()) as { ok: boolean; phone: string };
    expect(data.ok).toBe(true);
    expect(data.phone).toBe(PHONE);
  });
});

/**
 * Admin opt-out management routes.
 * GET    /api/admin/sessions/:id/optouts
 * POST   /api/admin/sessions/:id/optouts
 * DELETE /api/admin/sessions/:id/optouts/:phone
 *
 * Mocked boundaries:
 *   - @/lib/require-admin
 *   - @/lib/repositories/optouts, listOptOuts, addOptOut, removeOptOut
 *   - @/lib/repositories/sessions, getSession
 *   - @/lib/repositories/audit, appendAudit
 *   - @/lib/logger, logger
 *   - @/lib/request-id, mintRequestId
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- module mocks -----------------------------------------------------------

vi.mock('@/lib/require-admin', () => ({
  requireAdmin: vi.fn(),
}));

vi.mock('@/lib/repositories/optouts', () => ({
  listOptOuts: vi.fn(),
  addOptOut: vi.fn().mockResolvedValue(undefined),
  removeOptOut: vi.fn(),
}));

vi.mock('@/lib/repositories/sessions', () => ({
  getSession: vi.fn(),
  getCachedSession: vi.fn(),
}));

vi.mock('@/lib/repositories/audit', () => ({
  appendAudit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/request-id', () => ({
  mintRequestId: vi.fn(() => 'req-test'),
}));

// ---- imports after mocks ----------------------------------------------------

import { GET as listGET, POST as createPOST } from '@/app/api/admin/sessions/[id]/optouts/route';
import { DELETE } from '@/app/api/admin/sessions/[id]/optouts/[phone]/route';
import { requireAdmin } from '@/lib/require-admin';
import { listOptOuts, addOptOut, removeOptOut } from '@/lib/repositories/optouts';
import { getSession } from '@/lib/repositories/sessions';
import type { SessionDoc } from '@/lib/repositories/sessions';
import type { OptOut } from '@hmddevs/protocol';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockRequireAdmin = requireAdmin as ReturnType<typeof vi.fn>;
const mockListOptOuts = listOptOuts as ReturnType<typeof vi.fn>;
const mockAddOptOut = addOptOut as ReturnType<typeof vi.fn>;
const mockRemoveOptOut = removeOptOut as ReturnType<typeof vi.fn>;
const mockGetSession = getSession as ReturnType<typeof vi.fn>;

const SESSION_ID = 'test-session';

function makeAdminContext() {
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

function makeOptOut(overrides: Partial<OptOut> = {}): OptOut {
  return {
    sessionId: SESSION_ID,
    phone: '+447700900123',
    source: 'admin',
    createdAt: new Date(),
    ...overrides,
  };
}

function makeParams(id: string): Promise<{ id: string }> {
  return Promise.resolve({ id });
}

function makePhoneParams(id: string, phone: string): Promise<{ id: string; phone: string }> {
  return Promise.resolve({ id, phone });
}

function makeGetRequest(sessionId: string): Request {
  return new Request(`https://wa.test/api/admin/sessions/${sessionId}/optouts`, {
    method: 'GET',
    headers: { 'content-type': 'application/json' },
  });
}

function makePostRequest(sessionId: string, body: unknown): Request {
  const json = JSON.stringify(body);
  return new Request(`https://wa.test/api/admin/sessions/${sessionId}/optouts`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(json)),
    },
    body: json,
  });
}

function makeDeleteRequest(sessionId: string, phone: string): Request {
  return new Request(
    `https://wa.test/api/admin/sessions/${sessionId}/optouts/${encodeURIComponent(phone)}`,
    {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
    },
  );
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAdmin.mockResolvedValue(makeAdminContext());
  mockGetSession.mockResolvedValue(makeSession());
});

// ---------------------------------------------------------------------------
// GET /api/admin/sessions/:id/optouts, list
// ---------------------------------------------------------------------------

describe('GET /api/admin/sessions/:id/optouts', () => {
  it('returns 200 with the opt-out list', async () => {
    const optOut = makeOptOut();
    mockListOptOuts.mockResolvedValue([optOut]);

    const res = await listGET(makeGetRequest(SESSION_ID), {
      params: makeParams(SESSION_ID),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { optOuts: unknown[] };
    expect(Array.isArray(body.optOuts)).toBe(true);
    expect(body.optOuts).toHaveLength(1);
  });

  it('returns an empty array when the session has no opt-outs', async () => {
    mockListOptOuts.mockResolvedValue([]);

    const res = await listGET(makeGetRequest(SESSION_ID), {
      params: makeParams(SESSION_ID),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { optOuts: unknown[] };
    expect(body.optOuts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// POST /api/admin/sessions/:id/optouts, add
// ---------------------------------------------------------------------------

describe('POST /api/admin/sessions/:id/optouts', () => {
  it('returns 201 with phone and source on a valid E.164 number', async () => {
    const res = await createPOST(makePostRequest(SESSION_ID, { phone: '+447700900123' }), {
      params: makeParams(SESSION_ID),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { phone: string; source: string };
    expect(body.phone).toBe('+447700900123');
    expect(body.source).toBe('admin');
    expect(mockAddOptOut).toHaveBeenCalledWith(SESSION_ID, '+447700900123', 'admin');
  });

  it('returns 400 for an invalid (non-E.164) phone number', async () => {
    const res = await createPOST(makePostRequest(SESSION_ID, { phone: '07700900123' }), {
      params: makeParams(SESSION_ID),
    });

    expect(res.status).toBe(400);
    expect(mockAddOptOut).not.toHaveBeenCalled();
  });

  it('returns 400 when phone field is missing', async () => {
    const res = await createPOST(makePostRequest(SESSION_ID, {}), {
      params: makeParams(SESSION_ID),
    });

    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/admin/sessions/:id/optouts/:phone, remove
// ---------------------------------------------------------------------------

describe('DELETE /api/admin/sessions/:id/optouts/:phone', () => {
  it('returns 204 when the opt-out record is removed', async () => {
    mockRemoveOptOut.mockResolvedValue(true);

    const res = await DELETE(makeDeleteRequest(SESSION_ID, '+447700900123'), {
      params: makePhoneParams(SESSION_ID, encodeURIComponent('+447700900123')),
    });

    expect(res.status).toBe(204);
  });

  it('returns 404 when no opt-out record exists for that phone', async () => {
    mockRemoveOptOut.mockResolvedValue(false);

    const res = await DELETE(makeDeleteRequest(SESSION_ID, '+447700900999'), {
      params: makePhoneParams(SESSION_ID, encodeURIComponent('+447700900999')),
    });

    expect(res.status).toBe(404);
  });
});

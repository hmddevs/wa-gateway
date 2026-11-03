/**
 * Admin session metrics, route handler tests.
 *
 * GET /api/admin/sessions/:id/metrics
 *
 * Mocked boundaries:
 *   - @/lib/require-admin
 *   - @/lib/admin-rate-limit, checkAdminLimit + adminLimiterKey
 *   - @/lib/repositories/sessions, getSession
 *   - @/lib/repositories/metrics, getSessionMetrics
 *   - @/lib/logger, logger
 *   - @/lib/request-id, mintRequestId
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- module mocks -----------------------------------------------------------

vi.mock('@/lib/require-admin', () => ({
  requireAdmin: vi.fn(),
}));

vi.mock('@/lib/admin-rate-limit', () => ({
  adminLimiterKey: vi.fn(() => 'sess:test'),
  checkAdminLimit: vi.fn(async () => true),
}));

vi.mock('@/lib/repositories/sessions', () => ({
  getSession: vi.fn(),
  getCachedSession: vi.fn(),
}));

vi.mock('@/lib/repositories/metrics', () => ({
  getSessionMetrics: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/request-id', () => ({
  mintRequestId: vi.fn(() => 'req-test'),
}));

// ---- imports after mocks ----------------------------------------------------

import { GET } from '../route';
import { requireAdmin } from '@/lib/require-admin';
import { checkAdminLimit } from '@/lib/admin-rate-limit';
import { getSession } from '@/lib/repositories/sessions';
import { getSessionMetrics } from '@/lib/repositories/metrics';
import type { AdminSessionMetrics } from '@hmddevs/protocol';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockRequireAdmin = requireAdmin as ReturnType<typeof vi.fn>;
const mockCheckAdminLimit = checkAdminLimit as ReturnType<typeof vi.fn>;
const mockGetSession = getSession as ReturnType<typeof vi.fn>;
const mockGetSessionMetrics = getSessionMetrics as ReturnType<typeof vi.fn>;

function makeReq(sessionId = 'session-1') {
  return new Request(`http://localhost/api/admin/sessions/${sessionId}/metrics`);
}

function makeCtx(id = 'session-1') {
  return { params: Promise.resolve({ id }) };
}

const FIXTURE: AdminSessionMetrics = {
  sessionId: 'session-1',
  window: { from: new Date(0).toISOString(), to: new Date().toISOString() },
  messages: {
    sent24h: 5,
    received24h: 3,
    failed24h: 1,
    sentSparkline: Array.from({ length: 24 }, (_, i) => ({ hour: i, count: 0 })),
    receivedSparkline: Array.from({ length: 24 }, (_, i) => ({ hour: i, count: 0 })),
  },
  webhooks: { delivered24h: 2, failed24h: 0 },
  workerStatus: 'connected',
  cachedAt: new Date().toISOString(),
};

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAdmin.mockResolvedValue({
    ok: true,
    admin: { email: 'a@hmd.test', sessionId: 'admin-sess', webauthnFreshAt: null },
  });
  mockCheckAdminLimit.mockResolvedValue(true);
  mockGetSession.mockResolvedValue({ sessionId: 'session-1', workerId: 'w1', status: 'connected' });
  mockGetSessionMetrics.mockResolvedValue(FIXTURE);
});

// ---------------------------------------------------------------------------
// GET /api/admin/sessions/:id/metrics
// ---------------------------------------------------------------------------

describe('GET /api/admin/sessions/:id/metrics', () => {
  it('returns 401 when requireAdmin returns { ok: false, status: 401 }', async () => {
    mockRequireAdmin.mockResolvedValue({ ok: false, status: 401, message: 'Not signed in' });

    const res = await GET(makeReq(), makeCtx());

    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('UNAUTHORIZED');
  });

  it('returns 400 for an invalid session id', async () => {
    const res = await GET(makeReq('BAD ID'), makeCtx('BAD ID'));

    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('INVALID_BODY');
  });

  it('returns 429 when checkAdminLimit returns false', async () => {
    mockCheckAdminLimit.mockResolvedValue(false);

    const res = await GET(makeReq(), makeCtx());

    expect(res.status).toBe(429);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('RATE_LIMITED');
  });

  it('returns 404 when getSession returns null', async () => {
    mockGetSession.mockResolvedValue(null);

    const res = await GET(makeReq(), makeCtx());

    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('INVALID_BODY');
  });

  it('returns 200 with the metrics payload when everything resolves', async () => {
    const res = await GET(makeReq(), makeCtx());

    expect(res.status).toBe(200);
    const body = (await res.json()) as AdminSessionMetrics;
    expect(body.sessionId).toBe(FIXTURE.sessionId);
    expect(body.messages.sent24h).toBe(FIXTURE.messages.sent24h);
    expect(body.messages.received24h).toBe(FIXTURE.messages.received24h);
    expect(body.messages.failed24h).toBe(FIXTURE.messages.failed24h);
    expect(body.messages.sentSparkline).toHaveLength(24);
    expect(body.messages.receivedSparkline).toHaveLength(24);
    expect(body.webhooks.delivered24h).toBe(FIXTURE.webhooks.delivered24h);
    expect(body.webhooks.failed24h).toBe(FIXTURE.webhooks.failed24h);
    expect(body.workerStatus).toBe('connected');
  });

  it('returns 500 when getSessionMetrics throws', async () => {
    mockGetSessionMetrics.mockRejectedValue(new Error('mongo exploded'));

    const res = await GET(makeReq(), makeCtx());

    expect(res.status).toBe(500);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('INTERNAL');
  });
});

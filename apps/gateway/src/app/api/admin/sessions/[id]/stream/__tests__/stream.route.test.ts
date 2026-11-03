/**
 * GET /api/admin/sessions/:id/stream, connection-time gate tests.
 *
 * Tests the auth, rate-limit and session-id validation guards that execute
 * before the ReadableStream is opened. The long-lived stream body, heartbeat
 * timer, and Redis subscriber are not exercised here, no test infra for
 * long-lived streams exists in this repo.
 *
 * Mocked boundaries:
 *   @/lib/require-admin, requireAdmin
 *   @/lib/admin-rate-limit, checkAdminLimit, adminLimiterKey
 *   @/lib/repositories/sessions, getSession
 *   @/lib/admin-stream, adminStreamChannel
 *   @/lib/env, env
 *   @/lib/logger, logger
 *   @/lib/request-id, mintRequestId
 *   ioredis, Redis constructor (prevent real connection)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('@/lib/require-admin', () => ({
  requireAdmin: vi.fn(),
}));

vi.mock('@/lib/admin-rate-limit', () => ({
  adminLimiterKey: vi.fn(() => 'sess:admin-sess'),
  checkAdminLimit: vi.fn(async () => true),
}));

vi.mock('@/lib/repositories/sessions', () => ({
  getSession: vi.fn(),
  getCachedSession: vi.fn(),
}));

vi.mock('@/lib/admin-stream', () => ({
  adminStreamChannel: vi.fn((id: string) => `admin:stream:${id}`),
  publishAdminStream: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/env', () => ({
  env: { UPSTASH_REDIS_URL: 'redis://localhost:6379' },
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/request-id', () => ({
  mintRequestId: vi.fn(() => 'req-stream-test'),
}));

// Prevent the route from opening a real Redis connection during tests.
vi.mock('ioredis', () => ({
  Redis: vi.fn().mockImplementation(() => ({
    subscribe: vi.fn().mockResolvedValue(undefined),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
    quit: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    on: vi.fn(),
  })),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { GET } from '../route';
import { requireAdmin } from '@/lib/require-admin';
import { checkAdminLimit } from '@/lib/admin-rate-limit';
import { getSession } from '@/lib/repositories/sessions';

// ---------------------------------------------------------------------------
// Typed mock references
// ---------------------------------------------------------------------------

const mockRequireAdmin = requireAdmin as ReturnType<typeof vi.fn>;
const mockCheckAdminLimit = checkAdminLimit as ReturnType<typeof vi.fn>;
const mockGetSession = getSession as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReq(id = 'session-1') {
  return new Request(`http://localhost/api/admin/sessions/${id}/stream`);
}

function makeCtx(id = 'session-1') {
  return { params: Promise.resolve({ id }) };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAdmin.mockResolvedValue({
    ok: true,
    admin: { email: 'admin@hmd.test', sessionId: 'admin-sess', webauthnFreshAt: null },
  });
  mockCheckAdminLimit.mockResolvedValue(true);
  mockGetSession.mockResolvedValue({ sessionId: 'session-1', workerId: 'w1', status: 'connected' });
});

// ---------------------------------------------------------------------------
// Auth gate
// ---------------------------------------------------------------------------

describe('GET /api/admin/sessions/:id/stream, auth gate', () => {
  it('returns 401 when requireAdmin returns { ok: false, status: 401 }', async () => {
    mockRequireAdmin.mockResolvedValue({ ok: false, status: 401, message: 'Not signed in' });

    const res = await GET(makeReq(), makeCtx());

    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('UNAUTHORIZED');
  });
});

// ---------------------------------------------------------------------------
// Rate-limit gate
// ---------------------------------------------------------------------------

describe('GET /api/admin/sessions/:id/stream, rate-limit gate', () => {
  it('returns 429 when checkAdminLimit returns false', async () => {
    mockCheckAdminLimit.mockResolvedValue(false);

    const res = await GET(makeReq(), makeCtx());

    expect(res.status).toBe(429);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('RATE_LIMITED');
  });
});

// ---------------------------------------------------------------------------
// Session-id validation gate
// ---------------------------------------------------------------------------

describe('GET /api/admin/sessions/:id/stream, session id validation', () => {
  it('returns 400 when the session id contains invalid characters', async () => {
    const res = await GET(makeReq('BAD ID!!'), makeCtx('BAD ID!!'));

    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('INVALID_BODY');
  });

  it('returns 400 when the session id is a single character (too short)', async () => {
    const res = await GET(makeReq('x'), makeCtx('x'));

    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('INVALID_BODY');
  });
});

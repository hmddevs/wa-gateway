/**
 * POST /v1/sessions/:sessionId/presence, route tests.
 *
 * Mocked boundaries:
 *   - @/lib/auth-api
 *   - @/lib/repositories/sessions, getSession
 *   - @/lib/repositories/audit, appendAudit
 *   - @/lib/redis, getRedis
 *   - @/lib/wire, sign, channels, newNonce, nowIso
 *   - @/lib/phone, normalisePhone, jidFromE164
 *   - @/lib/logger, logger
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- module mocks ----------------------------------------------------------

vi.mock('@/lib/auth-api', () => ({
  authenticate: vi.fn(),
  requireScope: vi.fn(),
}));

vi.mock('@/lib/repositories/sessions', () => ({
  getSession: vi.fn(),
  getCachedSession: vi.fn(),
}));

vi.mock('@/lib/repositories/audit', () => ({
  appendAudit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/redis', () => ({
  getRedis: vi.fn(),
}));

vi.mock('@/lib/wire', () => ({
  sign: vi.fn(async (env: unknown) => env),
  channels: {
    outbound: (id: string) => `wa:outbound:${id}`,
  },
  newNonce: () => 'test-nonce',
  nowIso: () => new Date().toISOString(),
}));

vi.mock('@/lib/phone', () => ({
  normalisePhone: vi.fn((n: string) => n),
  jidFromE164: vi.fn((n: string) => `${n.slice(1)}@s.whatsapp.net`),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ---- imports after mocks ---------------------------------------------------

import { POST } from '@/app/v1/sessions/[sessionId]/presence/route';
import { authenticate, requireScope } from '@/lib/auth-api';
import { getSession, getCachedSession } from '@/lib/repositories/sessions';
import { getRedis } from '@/lib/redis';
import type { ApiKeyDoc } from '@/lib/repositories/api-keys';
import type { SessionDoc } from '@/lib/repositories/sessions';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockAuthenticate = authenticate as ReturnType<typeof vi.fn>;
const mockRequireScope = requireScope as ReturnType<typeof vi.fn>;
const mockGetSession = getSession as ReturnType<typeof vi.fn>;
const mockGetCachedSession = getCachedSession as ReturnType<typeof vi.fn>;
const mockGetRedis = getRedis as ReturnType<typeof vi.fn>;

const SESSION_ID = 'test-session';

function makeApiKey(overrides: Partial<ApiKeyDoc> = {}): ApiKeyDoc {
  return {
    keyId: 'key_abc',
    keyLookupHash: 'abc',
    keyHash: 'hash',
    label: 'Test Key',
    division: 'test',
    env: 'test',
    scopes: ['send:transactional'],
    rateLimitPerMin: 100,
    sessionId: SESSION_ID,
    createdBy: 'admin@test.com',
    createdAt: new Date(),
    ...overrides,
  } as ApiKeyDoc;
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

function makeRequest(pathSessionId: string, body: unknown): Request {
  return new Request(`https://wa.test/v1/sessions/${pathSessionId}/presence`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer test-api-key',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

function makeParams(sessionId = SESSION_ID): Promise<{ sessionId: string }> {
  return Promise.resolve({ sessionId });
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();

  mockAuthenticate.mockResolvedValue({
    ok: true,
    apiKey: makeApiKey(),
    ip: '1.2.3.4',
    requestId: 'req-test',
  });
  mockRequireScope.mockReturnValue(true);
  mockGetSession.mockResolvedValue(makeSession());
  mockGetCachedSession.mockResolvedValue(makeSession());
  mockGetRedis.mockReturnValue({ publish: vi.fn().mockResolvedValue(1) });
});

// ---------------------------------------------------------------------------
// Path sessionId must match API key sessionId
// ---------------------------------------------------------------------------

describe('presence POST, session scope', () => {
  it('returns 403 SCOPE_DENIED when path sessionId differs from API key sessionId', async () => {
    const res = await POST(makeRequest('different-session', { state: 'composing' }), {
      params: makeParams('different-session'),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('SCOPE_DENIED');
  });
});

// ---------------------------------------------------------------------------
// Invalid presence state
// ---------------------------------------------------------------------------

describe('presence POST, invalid state', () => {
  it('returns 422 INVALID_PRESENCE_STATE on an unknown state value', async () => {
    const res = await POST(makeRequest(SESSION_ID, { state: 'invisible' }), {
      params: makeParams(),
    });

    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('INVALID_PRESENCE_STATE');
  });
});

// ---------------------------------------------------------------------------
// Session offline
// ---------------------------------------------------------------------------

describe('presence POST, session connectivity', () => {
  it('returns 503 WORKER_UNAVAILABLE when session is offline', async () => {
    mockGetCachedSession.mockResolvedValue(makeSession({ status: 'offline' }));

    const res = await POST(makeRequest(SESSION_ID, { state: 'available' }), {
      params: makeParams(),
    });

    expect(res.status).toBe(503);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('WORKER_UNAVAILABLE');
  });

  it('returns 503 WORKER_UNAVAILABLE when session does not exist', async () => {
    mockGetCachedSession.mockResolvedValue(null);

    const res = await POST(makeRequest(SESSION_ID, { state: 'available' }), {
      params: makeParams(),
    });

    expect(res.status).toBe(503);
  });
});

// ---------------------------------------------------------------------------
// Happy path, with explicit to
// ---------------------------------------------------------------------------

describe('presence POST, happy path with to', () => {
  it('returns 200 with status queued and publishes (no lpush)', async () => {
    const publishMock = vi.fn().mockResolvedValue(1);
    mockGetRedis.mockReturnValue({ publish: publishMock });

    const res = await POST(makeRequest(SESSION_ID, { state: 'composing', to: '+447700900123' }), {
      params: makeParams(),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('queued');

    expect(publishMock).toHaveBeenCalledOnce();
    const publishArgs = publishMock.mock.calls[0] as [string];
    expect(publishArgs[0]).toBe(`wa:outbound:${SESSION_ID}`);
  });

  it('does not call lpush on the pending list (fire-and-forget)', async () => {
    const redisMock = { publish: vi.fn().mockResolvedValue(1), lpush: vi.fn() };
    mockGetRedis.mockReturnValue(redisMock);

    await POST(makeRequest(SESSION_ID, { state: 'composing', to: '+447700900123' }), {
      params: makeParams(),
    });

    expect(redisMock.lpush).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Happy path, without to (global presence)
// ---------------------------------------------------------------------------

describe('presence POST, happy path without to', () => {
  it('returns 200 with status queued when to is omitted', async () => {
    const publishMock = vi.fn().mockResolvedValue(1);
    mockGetRedis.mockReturnValue({ publish: publishMock });

    const res = await POST(makeRequest(SESSION_ID, { state: 'available' }), {
      params: makeParams(),
    });

    expect(res.status).toBe(200);
  });

  it('publishes an envelope without waJid when to is omitted', async () => {
    const { sign } = await import('@/lib/wire');
    const mockSign = sign as ReturnType<typeof vi.fn>;

    const publishMock = vi.fn().mockResolvedValue(1);
    mockGetRedis.mockReturnValue({ publish: publishMock });

    await POST(makeRequest(SESSION_ID, { state: 'unavailable' }), {
      params: makeParams(),
    });

    const signCallArg = mockSign.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(signCallArg?.waJid).toBeUndefined();
  });
});

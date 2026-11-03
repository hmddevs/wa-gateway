/**
 * POST/DELETE /v1/messages/:id/reactions, route tests.
 *
 * Mocked boundaries:
 *   - @/lib/auth-api, authenticate + requireScope
 *   - @/lib/repositories/messages, findByMessageId
 *   - @/lib/repositories/sessions, getSession
 *   - @/lib/repositories/audit, appendAudit
 *   - @/lib/redis, getRedis
 *   - @/lib/wire, sign, channels, newNonce, nowIso
 *   - @/lib/phone, jidFromE164
 *   - @/lib/logger, logger
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- module mocks (declared before imports) --------------------------------

vi.mock('@/lib/auth-api', () => ({
  authenticate: vi.fn(),
  requireScope: vi.fn(),
}));

vi.mock('@/lib/repositories/messages', () => ({
  findByMessageId: vi.fn(),
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
    pending: (id: string) => `wa:pending:${id}`,
  },
  newNonce: () => 'test-nonce',
  nowIso: () => new Date().toISOString(),
  lpushPending: vi.fn().mockResolvedValue(undefined),
  PENDING_LIST_TTL_SECONDS: 86400,
}));

vi.mock('@/lib/phone', () => ({
  jidFromE164: vi.fn((n: string) => `${n.slice(1)}@s.whatsapp.net`),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ---- imports after mocks ---------------------------------------------------

import { POST, DELETE } from '@/app/v1/messages/[id]/reactions/route';
import { authenticate, requireScope } from '@/lib/auth-api';
import { findByMessageId } from '@/lib/repositories/messages';
import { getSession, getCachedSession } from '@/lib/repositories/sessions';
import { getRedis } from '@/lib/redis';
import { lpushPending } from '@/lib/wire';
import type { ApiKeyDoc } from '@/lib/repositories/api-keys';
import type { MessageDoc } from '@/lib/repositories/messages';
import type { SessionDoc } from '@/lib/repositories/sessions';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockAuthenticate = authenticate as ReturnType<typeof vi.fn>;
const mockRequireScope = requireScope as ReturnType<typeof vi.fn>;
const mockFindByMessageId = findByMessageId as ReturnType<typeof vi.fn>;
const mockGetSession = getSession as ReturnType<typeof vi.fn>;
const mockGetCachedSession = getCachedSession as ReturnType<typeof vi.fn>;
const mockGetRedis = getRedis as ReturnType<typeof vi.fn>;
const mockLpushPending = lpushPending as ReturnType<typeof vi.fn>;

const SESSION_ID = 'test-session';
const MSG_UUID = '00000000-0000-4000-8000-000000000001';

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

function makeMessage(overrides: Partial<MessageDoc> = {}): MessageDoc {
  return {
    messageId: MSG_UUID,
    apiKeyId: 'key_abc',
    to: '+447700900123',
    channel: 'transactional',
    body: { kind: 'text', text: 'Hello' },
    status: 'sent',
    statusHistory: [],
    waMessageId: 'wa-abc-123',
    workerId: 'worker-1',
    sessionId: SESSION_ID,
    createdAt: new Date(),
    ttlExpiresAt: new Date(Date.now() + 30 * 60 * 1000),
    requestId: 'req-abc',
    ...overrides,
  } as MessageDoc;
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

function makeRedisMulti() {
  const multi = {
    lpush: vi.fn().mockReturnThis(),
    publish: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue([1, 1]),
  };
  return multi;
}

function makeRequest(body: unknown, method = 'POST'): Request {
  return new Request(`https://wa.test/v1/messages/${MSG_UUID}/reactions`, {
    method,
    headers: {
      authorization: 'Bearer test-api-key',
      'content-type': 'application/json',
    },
    body: body !== null ? JSON.stringify(body) : undefined,
  });
}

function makeParams(id = MSG_UUID): Promise<{ id: string }> {
  return Promise.resolve({ id });
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();

  // Default: auth succeeds, scope check passes, message exists, session connected.
  mockAuthenticate.mockResolvedValue({
    ok: true,
    apiKey: makeApiKey(),
    ip: '1.2.3.4',
    requestId: 'req-test',
  });
  mockRequireScope.mockReturnValue(true);
  mockFindByMessageId.mockResolvedValue(makeMessage());
  mockGetSession.mockResolvedValue(makeSession());
  mockGetCachedSession.mockResolvedValue(makeSession());

  const multi = makeRedisMulti();
  mockGetRedis.mockReturnValue({ multi: () => multi, publish: vi.fn().mockResolvedValue(1) });
});

// ---------------------------------------------------------------------------
// Auth failures
// ---------------------------------------------------------------------------

describe('reactions POST, authentication', () => {
  it('returns 401 when authentication fails', async () => {
    mockAuthenticate.mockResolvedValue({
      ok: false,
      response: new Response(
        JSON.stringify({ error: 'Missing bearer token', code: 'UNAUTHORIZED', requestId: 'r' }),
        { status: 401 },
      ),
    });

    const res = await POST(makeRequest({ emoji: '👍' }), { params: makeParams() });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Scope denial
// ---------------------------------------------------------------------------

describe('reactions POST, scope check', () => {
  it('returns 403 SCOPE_DENIED when api key lacks send:transactional', async () => {
    mockRequireScope.mockReturnValue(false);

    const res = await POST(makeRequest({ emoji: '👍' }), { params: makeParams() });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('SCOPE_DENIED');
  });
});

// ---------------------------------------------------------------------------
// Invalid UUID param
// ---------------------------------------------------------------------------

describe('reactions POST, UUID validation', () => {
  it('returns 400 when :id is not a valid UUID', async () => {
    const res = await POST(makeRequest({ emoji: '👍' }), { params: makeParams('not-a-uuid') });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('INVALID_BODY');
  });
});

// ---------------------------------------------------------------------------
// Message not found
// ---------------------------------------------------------------------------

describe('reactions POST, message lookup', () => {
  it('returns 404 RECIPIENT_NOT_FOUND when message does not exist', async () => {
    mockFindByMessageId.mockResolvedValue(null);

    const res = await POST(makeRequest({ emoji: '👍' }), { params: makeParams() });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('RECIPIENT_NOT_FOUND');
  });

  it('returns 404 RECIPIENT_NOT_FOUND when message belongs to a different session', async () => {
    mockFindByMessageId.mockResolvedValue(makeMessage({ sessionId: 'other-session' }));

    const res = await POST(makeRequest({ emoji: '👍' }), { params: makeParams() });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('RECIPIENT_NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// Message not yet sent (no waMessageId)
// ---------------------------------------------------------------------------

describe('reactions POST, waMessageId guard', () => {
  it('returns 422 INVALID_REACTION when message has no waMessageId yet', async () => {
    mockFindByMessageId.mockResolvedValue(makeMessage({ waMessageId: null }));

    const res = await POST(makeRequest({ emoji: '👍' }), { params: makeParams() });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('INVALID_REACTION');
  });
});

// ---------------------------------------------------------------------------
// Session offline
// ---------------------------------------------------------------------------

describe('reactions POST, session connectivity', () => {
  it('returns 503 WORKER_UNAVAILABLE when session is not connected', async () => {
    mockGetCachedSession.mockResolvedValue(makeSession({ status: 'offline' }));

    const res = await POST(makeRequest({ emoji: '👍' }), { params: makeParams() });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('WORKER_UNAVAILABLE');
  });

  it('returns 503 WORKER_UNAVAILABLE when session does not exist', async () => {
    mockGetCachedSession.mockResolvedValue(null);

    const res = await POST(makeRequest({ emoji: '👍' }), { params: makeParams() });
    expect(res.status).toBe(503);
  });
});

// ---------------------------------------------------------------------------
// Empty emoji on POST
// ---------------------------------------------------------------------------

describe('reactions POST, empty emoji', () => {
  it('returns 422 INVALID_REACTION when emoji is an empty string', async () => {
    const res = await POST(makeRequest({ emoji: '' }), { params: makeParams() });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('INVALID_REACTION');
  });
});

// ---------------------------------------------------------------------------
// POST happy path
// ---------------------------------------------------------------------------

describe('reactions POST, happy path', () => {
  it('returns 202 with messageId, emoji, and status queued', async () => {
    const multi = makeRedisMulti();
    mockGetRedis.mockReturnValue({ multi: () => multi, publish: vi.fn().mockResolvedValue(1) });

    const res = await POST(makeRequest({ emoji: '👍' }), { params: makeParams() });
    expect(res.status).toBe(202);

    const body = (await res.json()) as { messageId: string; emoji: string; status: string };
    expect(typeof body.messageId).toBe('string');
    expect(body.emoji).toBe('👍');
    expect(body.status).toBe('queued');
  });

  it('calls lpushPending and redis.publish on the correct channels', async () => {
    const publishMock = vi.fn().mockResolvedValue(1);
    mockGetRedis.mockReturnValue({ multi: () => makeRedisMulti(), publish: publishMock });

    await POST(makeRequest({ emoji: '👍' }), { params: makeParams() });

    expect(mockLpushPending).toHaveBeenCalledOnce();
    expect(publishMock).toHaveBeenCalledOnce();

    const lpushArgs = mockLpushPending.mock.calls[0] as [string, string];
    expect(lpushArgs[0]).toBe(SESSION_ID);

    const publishArgs = publishMock.mock.calls[0] as [string, string];
    expect(publishArgs[0]).toBe(`wa:outbound:${SESSION_ID}`);
  });
});

// ---------------------------------------------------------------------------
// DELETE happy path
// ---------------------------------------------------------------------------

describe('reactions DELETE, happy path', () => {
  it('returns 202 with empty emoji and audits message.unreact', async () => {
    const multi = makeRedisMulti();
    mockGetRedis.mockReturnValue({ multi: () => multi, publish: vi.fn().mockResolvedValue(1) });

    const req = new Request(`https://wa.test/v1/messages/${MSG_UUID}/reactions`, {
      method: 'DELETE',
      headers: { authorization: 'Bearer test-api-key' },
    });

    const res = await DELETE(req, { params: makeParams() });
    expect(res.status).toBe(202);

    const body = (await res.json()) as { emoji: string; status: string };
    expect(body.emoji).toBe('');
    expect(body.status).toBe('queued');
  });
});

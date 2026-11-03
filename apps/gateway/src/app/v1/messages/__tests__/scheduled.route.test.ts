/**
 * POST /v1/messages, scheduled send path.
 *
 * Mocked boundaries:
 *   - @/lib/auth-api
 *   - @/lib/repositories/messages, insertMessage, findByIdempotency, findReplyTarget
 *   - @/lib/repositories/sessions, getSession
 *   - @/lib/repositories/audit, appendAudit
 *   - @/lib/repositories/optouts, isOptedOut
 *   - @/lib/redis, getRedis
 *   - @/lib/wire, sign, channels, newNonce, nowIso
 *   - @/lib/phone, normalisePhone
 *   - @/lib/logger, logger
 *   - @/lib/webhook-dispatch, dispatchEventBackground
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- module mocks -----------------------------------------------------------

vi.mock('@/lib/session-state', () => ({
  penaliseSession: vi.fn().mockResolvedValue(undefined),
  rewardSession: vi.fn().mockResolvedValue(undefined),
  refundSend: vi.fn().mockResolvedValue(undefined),
  retryAfterSeconds: () => 30,
}));
vi.mock('@/lib/org-router', () => ({ routeSend: vi.fn() }));
vi.mock('@/lib/auth-api', () => ({
  authenticate: vi.fn(),
  requireScope: vi.fn(),
}));

vi.mock('@/lib/repositories/messages', () => ({
  insertMessage: vi.fn().mockResolvedValue(undefined),
  findByIdempotency: vi.fn().mockResolvedValue(null),
  findReplyTarget: vi.fn().mockResolvedValue(null),
  listByApiKey: vi.fn().mockResolvedValue([]),
}));

vi.mock('@/lib/repositories/sessions', () => ({
  getSession: vi.fn(),
  getCachedSession: vi.fn(),
}));

vi.mock('@/lib/repositories/audit', () => ({
  appendAudit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/repositories/organizations', () => ({
  isOptedOutAcrossOrg: vi.fn().mockResolvedValue(false),
}));

vi.mock('@/lib/rate-limit', () => ({
  checkRecipient: vi.fn().mockResolvedValue(true),
}));

vi.mock('@/lib/repositories/optouts', () => ({
  isOptedOut: vi.fn().mockResolvedValue(false),
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
  normalisePhone: vi.fn((n: string) => n),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/webhook-dispatch', () => ({
  dispatchEventBackground: vi.fn(),
}));

// ---- imports after mocks ----------------------------------------------------

import { POST } from '@/app/v1/messages/route';
import { authenticate, requireScope } from '@/lib/auth-api';
import { insertMessage } from '@/lib/repositories/messages';
import { getSession, getCachedSession } from '@/lib/repositories/sessions';
import { getRedis } from '@/lib/redis';
import { lpushPending } from '@/lib/wire';
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
const mockInsertMessage = insertMessage as ReturnType<typeof vi.fn>;
const mockLpushPending = lpushPending as ReturnType<typeof vi.fn>;

const SESSION_ID = 'test-session';

function makeApiKey(overrides: Partial<ApiKeyDoc> = {}): ApiKeyDoc {
  return {
    keyId: 'key_abc',
    keyLookupHash: 'abc',
    keyHash: 'hash',
    label: 'Test Key',
    division: 'test',
    env: 'test',
    projectId: 'acme',
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

function makeRedisMulti() {
  return {
    lpush: vi.fn().mockReturnThis(),
    publish: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue([1, 1]),
  };
}

function makeRequest(body: unknown): Request {
  return new Request('https://wa.test/v1/messages', {
    method: 'POST',
    headers: {
      authorization: 'Bearer test-api-key',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

const TEXT_BODY = { kind: 'text', text: 'Hello' };
const TO = '+447700900123';
const PURPOSE = 'otp' as const;

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

  const multi = makeRedisMulti();
  mockGetRedis.mockReturnValue({ multi: () => multi, publish: vi.fn().mockResolvedValue(1) });
});

// ---------------------------------------------------------------------------
// sendAt validation, too far in the past or too close
// ---------------------------------------------------------------------------

describe('POST /v1/messages, sendAt in the past', () => {
  it('returns 422 SEND_AT_PAST when sendAt is in the past', async () => {
    const sendAt = new Date(Date.now() - 60_000).toISOString();
    const res = await POST(makeRequest({ to: TO, body: TEXT_BODY, purpose: PURPOSE, sendAt }));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('SEND_AT_PAST');
  });

  it('returns 422 SEND_AT_PAST when sendAt is only 10 seconds from now (less than 30 s minimum)', async () => {
    const sendAt = new Date(Date.now() + 10_000).toISOString();
    const res = await POST(makeRequest({ to: TO, body: TEXT_BODY, purpose: PURPOSE, sendAt }));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('SEND_AT_PAST');
  });
});

describe('POST /v1/messages, sendAt too far out', () => {
  it('returns 422 INVALID_BODY when sendAt is more than 30 days away', async () => {
    const sendAt = new Date(Date.now() + 31 * 24 * 60 * 60 * 1_000).toISOString();
    const res = await POST(makeRequest({ to: TO, body: TEXT_BODY, purpose: PURPOSE, sendAt }));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('INVALID_BODY');
  });
});

// ---------------------------------------------------------------------------
// sendAt happy path, status: scheduled, no Redis publish
// ---------------------------------------------------------------------------

describe('POST /v1/messages, valid future sendAt', () => {
  it('returns 202 with status scheduled and skips Redis publish', async () => {
    const multi = makeRedisMulti();
    mockGetRedis.mockReturnValue({ multi: () => multi, publish: vi.fn().mockResolvedValue(1) });

    const sendAt = new Date(Date.now() + 60_000).toISOString();
    const res = await POST(makeRequest({ to: TO, body: TEXT_BODY, purpose: PURPOSE, sendAt }));

    expect(res.status).toBe(202);
    const resBody = (await res.json()) as { messageId: string; status: string };
    expect(resBody.status).toBe('scheduled');
    expect(typeof resBody.messageId).toBe('string');
  });

  it('inserts a Mongo doc with status scheduled and scheduledFor set', async () => {
    const sendAt = new Date(Date.now() + 60_000).toISOString();
    await POST(makeRequest({ to: TO, body: TEXT_BODY, purpose: PURPOSE, sendAt }));

    expect(mockInsertMessage).toHaveBeenCalledOnce();
    const insertedDoc = mockInsertMessage.mock.calls[0]![0] as {
      status: string;
      scheduledFor: Date | null;
    };
    expect(insertedDoc.status).toBe('scheduled');
    expect(insertedDoc.scheduledFor).toBeInstanceOf(Date);
  });

  it('does not call Redis publish or lpush for a scheduled message', async () => {
    const multi = makeRedisMulti();
    mockGetRedis.mockReturnValue({ multi: () => multi, publish: vi.fn().mockResolvedValue(1) });

    const sendAt = new Date(Date.now() + 60_000).toISOString();
    await POST(makeRequest({ to: TO, body: TEXT_BODY, purpose: PURPOSE, sendAt }));

    expect(multi.lpush).not.toHaveBeenCalled();
    expect(multi.publish).not.toHaveBeenCalled();
    expect(multi.exec).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// No sendAt, normal queue path unchanged
// ---------------------------------------------------------------------------

describe('POST /v1/messages, no sendAt (immediate send)', () => {
  it('returns 202 with status queued and calls Redis publish', async () => {
    const publishMock = vi.fn().mockResolvedValue(1);
    mockGetRedis.mockReturnValue({ multi: () => makeRedisMulti(), publish: publishMock });

    const res = await POST(makeRequest({ to: TO, body: TEXT_BODY, purpose: PURPOSE }));

    expect(res.status).toBe(202);
    const resBody = (await res.json()) as { status: string };
    expect(resBody.status).toBe('queued');

    expect(mockLpushPending).toHaveBeenCalledOnce();
    expect(publishMock).toHaveBeenCalledOnce();
  });
});

/**
 * POST /v1/messages, sync-confirm-send path.
 *
 * Mocked boundaries:
 *   - @/lib/auth-api
 *   - @/lib/repositories/messages, insertMessage, findByIdempotency, findReplyTarget
 *   - @/lib/repositories/sessions, getSession
 *   - @/lib/repositories/audit, appendAudit
 *   - @/lib/repositories/optouts, isOptedOut
 *   - @/lib/redis, getRedis, subscribeOnce
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
  subscribeOnce: vi.fn(),
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
import { insertMessage, findByIdempotency } from '@/lib/repositories/messages';
import { getSession, getCachedSession } from '@/lib/repositories/sessions';
import { getRedis, subscribeOnce } from '@/lib/redis';
import type { ApiKeyDoc } from '@/lib/repositories/api-keys';
import type { SessionDoc } from '@/lib/repositories/sessions';
import type { MessageDoc } from '@/lib/repositories/messages';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockAuthenticate = authenticate as ReturnType<typeof vi.fn>;
const mockRequireScope = requireScope as ReturnType<typeof vi.fn>;
const mockGetSession = getSession as ReturnType<typeof vi.fn>;
const mockGetCachedSession = getCachedSession as ReturnType<typeof vi.fn>;
const mockGetRedis = getRedis as ReturnType<typeof vi.fn>;
const mockInsertMessage = insertMessage as ReturnType<typeof vi.fn>;
const mockFindByIdempotency = findByIdempotency as ReturnType<typeof vi.fn>;
const mockSubscribeOnce = subscribeOnce as ReturnType<typeof vi.fn>;

const SESSION_ID = 'test-session';
const TO = '+447700900123';
const TEXT_BODY = { kind: 'text', text: 'Hello' };
const TS = '2026-05-05T12:00:00.000Z';
// A fixed UUID used in mock ack envelopes, must be a real UUID for SendAckEnvelopeSchema.
const MOCK_ACK_MESSAGE_ID = '00000000-0000-4000-8000-000000000099';

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

/** Build a subscribeOnce handle with prescribed resolution values. */
function makeSubscribeHandle(opts: {
  readyReject?: Error;
  messageValue: unknown | null;
}): ReturnType<typeof subscribeOnce> {
  return {
    ready: opts.readyReject ? Promise.reject(opts.readyReject) : Promise.resolve(),
    message: Promise.resolve(opts.messageValue),
  };
}

function makeExistingMessage(overrides: Partial<MessageDoc> = {}): MessageDoc {
  return {
    messageId: 'existing-uuid-0001',
    apiKeyId: 'key_abc',
    to: TO,
    channel: 'transactional',
    body: TEXT_BODY as MessageDoc['body'],
    idempotencyKey: 'idem-key-0001',
    status: 'queued',
    statusHistory: [],
    workerId: 'worker-1',
    sessionId: SESSION_ID,
    createdAt: new Date(),
    ttlExpiresAt: new Date(Date.now() + 3_600_000),
    requestId: 'req-existing',
    scheduledFor: null,
    dispatchedAt: null,
    ...overrides,
  } as MessageDoc;
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

  const multi = makeRedisMulti();
  mockGetRedis.mockReturnValue({ multi: () => multi, publish: vi.fn().mockResolvedValue(1) });

  // Default subscribeOnce: happy sent ack (messageId must be a UUID for SendAckEnvelopeSchema)
  mockSubscribeOnce.mockReturnValue(
    makeSubscribeHandle({
      messageValue: {
        messageId: MOCK_ACK_MESSAGE_ID,
        status: 'sent',
        waMessageId: 'wamid.X',
        ts: TS,
      },
    }),
  );
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /v1/messages, confirm', () => {
  it('happy ack: confirm=true resolves with status sent and requestId', async () => {
    // beforeEach sets a default subscribeOnce that returns a valid sent ack envelope.
    const res = await POST(
      makeRequest({ to: TO, body: TEXT_BODY, purpose: 'transactional', confirm: true }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; requestId: string; messageId: string };
    expect(body.status).toBe('sent');
    expect(typeof body.requestId).toBe('string');
    expect(typeof body.messageId).toBe('string');
  });

  it('failure ack: subscribeOnce resolves with status failed → 200 failed with errorCode', async () => {
    mockSubscribeOnce.mockReturnValue(
      makeSubscribeHandle({
        messageValue: {
          messageId: MOCK_ACK_MESSAGE_ID,
          status: 'failed',
          errorCode: 'SEND_FAILED',
          ts: TS,
        },
      }),
    );

    const res = await POST(
      makeRequest({ to: TO, body: TEXT_BODY, purpose: 'transactional', confirm: true }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; errorCode: string };
    expect(body.status).toBe('failed');
    expect(body.errorCode).toBe('SEND_FAILED');
  });

  it('timeout: subscribeOnce resolves null → 200 queued', async () => {
    mockSubscribeOnce.mockReturnValue(makeSubscribeHandle({ messageValue: null }));

    const res = await POST(
      makeRequest({ to: TO, body: TEXT_BODY, purpose: 'transactional', confirm: true }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; requestId: string };
    expect(body.status).toBe('queued');
    expect(typeof body.requestId).toBe('string');
  });

  it('scheduled + confirm rejected: sendAt future + confirm=true → 422 INVALID_BODY', async () => {
    const sendAt = new Date(Date.now() + 60_000).toISOString();
    const res = await POST(
      makeRequest({ to: TO, body: TEXT_BODY, purpose: 'transactional', sendAt, confirm: true }),
    );

    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('INVALID_BODY');
  });

  it('idempotent replay, terminal sent: returns 200 sent, idempotent: true, no subscribe', async () => {
    mockFindByIdempotency.mockResolvedValue(makeExistingMessage({ status: 'sent' }));

    const res = await POST(
      makeRequest({
        to: TO,
        body: TEXT_BODY,
        purpose: 'transactional',
        confirm: true,
        idempotencyKey: 'idem-key-0001',
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      idempotent: boolean;
      messageId: string;
      requestId: string;
    };
    expect(body.status).toBe('sent');
    expect(body.idempotent).toBe(true);
    expect(typeof body.messageId).toBe('string');
    expect(typeof body.requestId).toBe('string');
    expect(mockSubscribeOnce).not.toHaveBeenCalled();
  });

  it('idempotent replay, terminal failed: returns 200 failed, idempotent: true, no subscribe', async () => {
    mockFindByIdempotency.mockResolvedValue(
      makeExistingMessage({ status: 'failed', errorCode: 'SEND_FAILED' }),
    );

    const res = await POST(
      makeRequest({
        to: TO,
        body: TEXT_BODY,
        purpose: 'transactional',
        confirm: true,
        idempotencyKey: 'idem-key-0001',
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; idempotent: boolean; errorCode: string };
    expect(body.status).toBe('failed');
    expect(typeof body.errorCode).toBe('string');
    expect(body.idempotent).toBe(true);
    expect(mockSubscribeOnce).not.toHaveBeenCalled();
  });

  it('idempotent replay, expired: returns 200 failed with errorCode EXPIRED, no subscribe', async () => {
    mockFindByIdempotency.mockResolvedValue(makeExistingMessage({ status: 'expired' }));

    const res = await POST(
      makeRequest({
        to: TO,
        body: TEXT_BODY,
        purpose: 'transactional',
        confirm: true,
        idempotencyKey: 'idem-key-0001',
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; errorCode: string; idempotent: boolean };
    expect(body.status).toBe('failed');
    expect(body.errorCode).toBe('EXPIRED');
    expect(body.idempotent).toBe(true);
    expect(mockSubscribeOnce).not.toHaveBeenCalled();
  });

  it('idempotent replay, delivered maps to sent: returns 200 sent, idempotent: true', async () => {
    mockFindByIdempotency.mockResolvedValue(makeExistingMessage({ status: 'delivered' }));

    const res = await POST(
      makeRequest({
        to: TO,
        body: TEXT_BODY,
        purpose: 'transactional',
        confirm: true,
        idempotencyKey: 'idem-key-0001',
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; idempotent: boolean };
    expect(body.status).toBe('sent');
    expect(body.idempotent).toBe(true);
    expect(mockSubscribeOnce).not.toHaveBeenCalled();
  });

  it('idempotent replay, non-terminal queued: subscribes but does NOT lpush or publish', async () => {
    mockFindByIdempotency.mockResolvedValue(makeExistingMessage({ status: 'queued' }));
    // subscribeOnce times out → queued
    mockSubscribeOnce.mockReturnValue(makeSubscribeHandle({ messageValue: null }));

    const multi = makeRedisMulti();
    mockGetRedis.mockReturnValue({ multi: () => multi, publish: vi.fn().mockResolvedValue(1) });

    const res = await POST(
      makeRequest({
        to: TO,
        body: TEXT_BODY,
        purpose: 'transactional',
        confirm: true,
        idempotencyKey: 'idem-key-0001',
      }),
    );

    expect(res.status).toBe(200);
    expect(mockSubscribeOnce).toHaveBeenCalledOnce();
    expect(multi.lpush).not.toHaveBeenCalled();
    expect(multi.publish).not.toHaveBeenCalled();
  });

  it('subscribe error → 500 INTERNAL', async () => {
    const connectErr = new Error('ioredis connect failed');
    mockSubscribeOnce.mockReturnValue({
      ready: Promise.reject(connectErr),
      message: Promise.resolve(null),
    });

    const res = await POST(
      makeRequest({ to: TO, body: TEXT_BODY, purpose: 'transactional', confirm: true }),
    );

    expect(res.status).toBe(500);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('INTERNAL');
  });

  it('malformed ack envelope → 500 INTERNAL', async () => {
    // Garbage that cannot parse through SendAckEnvelopeSchema
    mockSubscribeOnce.mockReturnValue(
      makeSubscribeHandle({ messageValue: { completely: 'wrong' } }),
    );

    const res = await POST(
      makeRequest({ to: TO, body: TEXT_BODY, purpose: 'transactional', confirm: true }),
    );

    expect(res.status).toBe(500);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('INTERNAL');
  });

  it('worker offline short-circuits before subscribe: session disconnected → 503 WORKER_UNAVAILABLE', async () => {
    mockGetCachedSession.mockResolvedValue(
      makeSession({ status: 'disconnected' as SessionDoc['status'] }),
    );

    const res = await POST(
      makeRequest({ to: TO, body: TEXT_BODY, purpose: 'transactional', confirm: true }),
    );

    expect(res.status).toBe(503);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('WORKER_UNAVAILABLE');
    expect(mockSubscribeOnce).not.toHaveBeenCalled();
  });

  it('confirm without idempotency key works: bare confirm=true still 200 sent', async () => {
    // Uses the default subscribeOnce from beforeEach (valid UUID, status: sent).
    const res = await POST(
      makeRequest({ to: TO, body: TEXT_BODY, purpose: 'transactional', confirm: true }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('sent');
  });

  it('default async path unchanged: confirm omitted → 202 queued, no requestId in body', async () => {
    const multi = makeRedisMulti();
    mockGetRedis.mockReturnValue({ multi: () => multi, publish: vi.fn().mockResolvedValue(1) });

    const res = await POST(makeRequest({ to: TO, body: TEXT_BODY, purpose: 'transactional' }));

    expect(res.status).toBe(202);
    const body = (await res.json()) as { status: string; messageId: string; requestId?: string };
    expect(body.status).toBe('queued');
    expect(typeof body.messageId).toBe('string');
    // Back-compat: async path does NOT include requestId in response body
    expect(body.requestId).toBeUndefined();
    expect(mockSubscribeOnce).not.toHaveBeenCalled();
  });
});

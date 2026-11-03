/**
 * POST /v1/messages, group send path.
 *
 * Mocked boundaries: same as scheduled.route.test.ts.
 *   - @/lib/auth-api
 *   - @/lib/repositories/messages, insertMessage, findByIdempotency, findReplyTarget
 *   - @/lib/repositories/sessions, getSession, getCachedSession
 *   - @/lib/repositories/audit, appendAudit
 *   - @/lib/repositories/optouts, isOptedOut
 *   - @/lib/repositories/organizations, isOptedOutAcrossOrg
 *   - @/lib/org-router, routeSend
 *   - @/lib/rate-limit, checkRecipient
 *   - @/lib/redis, getRedis
 *   - @/lib/wire, sign, channels, newNonce, nowIso, lpushPending
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
import { getSession, getCachedSession } from '@/lib/repositories/sessions';
import { isOptedOut } from '@/lib/repositories/optouts';
import { getRedis } from '@/lib/redis';
import { sign, lpushPending } from '@/lib/wire';
import type { ApiKeyDoc } from '@/lib/repositories/api-keys';
import type { SessionDoc } from '@/lib/repositories/sessions';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockAuthenticate = authenticate as ReturnType<typeof vi.fn>;
const mockRequireScope = requireScope as ReturnType<typeof vi.fn>;
const mockGetSession = getSession as ReturnType<typeof vi.fn>;
const mockGetCachedSession = getCachedSession as ReturnType<typeof vi.fn>;
const mockIsOptedOut = isOptedOut as ReturnType<typeof vi.fn>;
const mockGetRedis = getRedis as ReturnType<typeof vi.fn>;
const mockSign = sign as ReturnType<typeof vi.fn>;
const mockLpushPending = lpushPending as ReturnType<typeof vi.fn>;

const SESSION_ID = 'test-session';
const GROUP_JID = '120363012345678901@g.us';

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
const PURPOSE = 'notification' as const;

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
  mockIsOptedOut.mockResolvedValue(false);
  mockSign.mockImplementation(async (env: unknown) => env);

  mockGetRedis.mockReturnValue({ publish: vi.fn().mockResolvedValue(1) });
});

// ---------------------------------------------------------------------------
// Group JID happy path
// ---------------------------------------------------------------------------

describe('POST /v1/messages, group JID send', () => {
  it('returns 202 queued for a valid group JID', async () => {
    const res = await POST(makeRequest({ to: GROUP_JID, body: TEXT_BODY, purpose: PURPOSE }));
    expect(res.status).toBe(202);
    const resBody = (await res.json()) as { status: string; messageId: string };
    expect(resBody.status).toBe('queued');
    expect(typeof resBody.messageId).toBe('string');
  });

  it('signs the envelope with the raw group JID as `to`, not normalised', async () => {
    await POST(makeRequest({ to: GROUP_JID, body: TEXT_BODY, purpose: PURPOSE }));

    expect(mockSign).toHaveBeenCalledOnce();
    const envelope = mockSign.mock.calls[0]![0] as { to: string };
    expect(envelope.to).toBe(GROUP_JID);
  });

  it('publishes and pushes to the pending list for a group send', async () => {
    const publishMock = vi.fn().mockResolvedValue(1);
    mockGetRedis.mockReturnValue({ publish: publishMock });

    await POST(makeRequest({ to: GROUP_JID, body: TEXT_BODY, purpose: PURPOSE }));

    expect(mockLpushPending).toHaveBeenCalledOnce();
    expect(publishMock).toHaveBeenCalledOnce();
  });

  it('does not consult the opt-out registry for a group send', async () => {
    await POST(makeRequest({ to: GROUP_JID, body: TEXT_BODY, purpose: PURPOSE }));
    expect(mockIsOptedOut).not.toHaveBeenCalled();
  });

  it('still enforces the per-recipient rate limit for a group send', async () => {
    const { checkRecipient } = await import('@/lib/rate-limit');
    await POST(makeRequest({ to: GROUP_JID, body: TEXT_BODY, purpose: PURPOSE }));
    expect(checkRecipient as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(GROUP_JID);
  });
});

// ---------------------------------------------------------------------------
// Group + replyTo is rejected
// ---------------------------------------------------------------------------

describe('POST /v1/messages, group JID with replyTo', () => {
  it('returns 422 INVALID_BODY, group quoting is not supported', async () => {
    const res = await POST(
      makeRequest({
        to: GROUP_JID,
        body: TEXT_BODY,
        purpose: PURPOSE,
        replyTo: { messageId: '11111111-1111-4111-a111-111111111111' },
      }),
    );
    expect(res.status).toBe(422);
    const resBody = (await res.json()) as { code: string };
    expect(resBody.code).toBe('INVALID_BODY');
  });
});

// ---------------------------------------------------------------------------
// Malformed group-ish JID is rejected
// ---------------------------------------------------------------------------

describe('POST /v1/messages, malformed group JID', () => {
  it('returns 400 INVALID_PHONE for a group-shaped but invalid JID', async () => {
    const res = await POST(
      makeRequest({ to: 'not-a-jid@g.us', body: TEXT_BODY, purpose: PURPOSE }),
    );
    expect(res.status).toBe(400);
    const resBody = (await res.json()) as { code: string };
    expect(resBody.code).toBe('INVALID_PHONE');
  });
});

// ---------------------------------------------------------------------------
// DM path is unaffected
// ---------------------------------------------------------------------------

describe('POST /v1/messages, DM send is unaffected', () => {
  const TO = '+447700900123';

  it('returns 202 queued for a normal phone number', async () => {
    const res = await POST(makeRequest({ to: TO, body: TEXT_BODY, purpose: PURPOSE }));
    expect(res.status).toBe(202);
    const resBody = (await res.json()) as { status: string };
    expect(resBody.status).toBe('queued');
  });

  it('still consults the opt-out registry for a DM', async () => {
    await POST(makeRequest({ to: TO, body: TEXT_BODY, purpose: PURPOSE }));
    expect(mockIsOptedOut).toHaveBeenCalledWith(SESSION_ID, TO);
  });
});

/**
 * POST /v1/messages, opt-out enforcement.
 *
 * Mocked boundaries: same as scheduled.route.test.ts.
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
  isOptedOut: vi.fn(),
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

const SESSION_ID = 'test-session';
const TO = '+447700900123';
const TEXT_BODY = { kind: 'text', text: 'Hello' };

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
  mockGetRedis.mockReturnValue({ multi: () => multi });
});

// ---------------------------------------------------------------------------
// Recipient on opt-out list
// ---------------------------------------------------------------------------

describe('POST /v1/messages, recipient opted out', () => {
  it('returns 422 OPTED_OUT when the recipient is on the opt-out list', async () => {
    mockIsOptedOut.mockResolvedValue(true);

    const res = await POST(makeRequest({ to: TO, body: TEXT_BODY, purpose: 'otp' }));

    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('OPTED_OUT');
  });
});

// ---------------------------------------------------------------------------
// Recipient not on opt-out list
// ---------------------------------------------------------------------------

describe('POST /v1/messages, recipient not opted out', () => {
  it('returns 202 queued when the recipient is not on the opt-out list', async () => {
    mockIsOptedOut.mockResolvedValue(false);

    const res = await POST(makeRequest({ to: TO, body: TEXT_BODY, purpose: 'otp' }));

    expect(res.status).toBe(202);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('queued');
  });
});

/**
 * POST /v1/messages, project/purpose metadata.
 *
 * Covers the field requirements introduced by the project-purpose gate:
 *   - `purpose` is required; absent or unknown values → 400
 *   - Persisted `MessageDoc` carries `projectId` from `apiKey.projectId`
 *     and `purpose` from the request
 *   - Published wire envelope includes `projectId` + `purpose`
 *   - Audit meta includes `projectId` + `purpose`
 *
 * Mocked boundaries, same set as scheduled.route.test.ts:
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
import { appendAudit } from '@/lib/repositories/audit';
import { getRedis } from '@/lib/redis';
import { sign } from '@/lib/wire';
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
const mockAppendAudit = appendAudit as ReturnType<typeof vi.fn>;
const mockSign = sign as ReturnType<typeof vi.fn>;

const SESSION_ID = 'test-session';
const WORKER_ID = 'worker-1';
const PROJECT_ID = 'acme';
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
    projectId: PROJECT_ID,
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
    workerId: WORKER_ID,
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
  mockInsertMessage.mockResolvedValue(undefined);
  mockAppendAudit.mockResolvedValue(undefined);
  mockSign.mockImplementation(async (e: unknown) => e);

  const multi = makeRedisMulti();
  mockGetRedis.mockReturnValue({ multi: () => multi });
});

// ---------------------------------------------------------------------------
// purpose, validation
// ---------------------------------------------------------------------------

describe("POST /v1/messages, 'purpose' field validation", () => {
  it("returns 400 INVALID_BODY when 'purpose' is missing from the body", async () => {
    const res = await POST(makeRequest({ to: TO, body: TEXT_BODY }));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { code: string };
    expect(json.code).toBe('INVALID_BODY');
  });

  it("returns 400 INVALID_BODY when 'purpose' is an unknown value", async () => {
    const res = await POST(makeRequest({ to: TO, body: TEXT_BODY, purpose: 'spam' }));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { code: string };
    expect(json.code).toBe('INVALID_BODY');
  });
});

// ---------------------------------------------------------------------------
// Happy path, purpose propagation
// ---------------------------------------------------------------------------

describe('POST /v1/messages, purpose happy path', () => {
  it('returns 202 with status queued for a valid send', async () => {
    const res = await POST(makeRequest({ to: TO, body: TEXT_BODY, purpose: 'otp' }));
    expect(res.status).toBe(202);
    const json = (await res.json()) as { status: string };
    expect(json.status).toBe('queued');
  });

  it('persisted MessageDoc carries projectId from apiKey and purpose', async () => {
    await POST(makeRequest({ to: TO, body: TEXT_BODY, purpose: 'otp' }));

    expect(mockInsertMessage).toHaveBeenCalledOnce();
    const doc = mockInsertMessage.mock.calls[0]![0] as {
      projectId: string;
      purpose: string;
    };
    expect(doc.projectId).toBe(PROJECT_ID);
    expect(doc.purpose).toBe('otp');
  });

  it('wire envelope includes projectId and purpose', async () => {
    await POST(makeRequest({ to: TO, body: TEXT_BODY, purpose: 'otp' }));

    expect(mockSign).toHaveBeenCalledOnce();
    const envelope = mockSign.mock.calls[0]![0] as Record<string, unknown>;
    expect(envelope.projectId).toBe(PROJECT_ID);
    expect(envelope.purpose).toBe('otp');
  });

  it('audit meta includes projectId and purpose', async () => {
    await POST(makeRequest({ to: TO, body: TEXT_BODY, purpose: 'notification' }));

    expect(mockAppendAudit).toHaveBeenCalledOnce();
    const auditCall = mockAppendAudit.mock.calls[0]![0] as {
      meta: Record<string, unknown>;
    };
    expect(auditCall.meta.projectId).toBe(PROJECT_ID);
    expect(auditCall.meta.purpose).toBe('notification');
  });
});

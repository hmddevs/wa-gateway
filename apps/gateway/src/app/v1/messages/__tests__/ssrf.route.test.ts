/**
 * POST /v1/messages, SSRF guard on media (image/document) bodies.
 *
 * Mocked boundaries: same as scheduled.route.test.ts, plus:
 *   - @/lib/safe-fetch, resolveSafeHost
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

vi.mock('@/lib/safe-fetch', () => ({
  resolveSafeHost: vi.fn(),
}));

// ---- imports after mocks ----------------------------------------------------

import { POST } from '@/app/v1/messages/route';
import { authenticate, requireScope } from '@/lib/auth-api';
import { getSession, getCachedSession } from '@/lib/repositories/sessions';
import { isOptedOut } from '@/lib/repositories/optouts';
import { getRedis } from '@/lib/redis';
import { sign, lpushPending } from '@/lib/wire';
import { resolveSafeHost } from '@/lib/safe-fetch';
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
const mockResolveSafeHost = resolveSafeHost as ReturnType<typeof vi.fn>;

const SESSION_ID = 'test-session';
const TO = '+447700900123';

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
const IMAGE_BODY = { kind: 'image', url: 'https://cdn.example.com/pic.png', caption: 'x' };
const DOCUMENT_BODY = {
  kind: 'document',
  url: 'https://cdn.example.com/file.pdf',
  filename: 'file.pdf',
};
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
  mockResolveSafeHost.mockResolvedValue({
    url: new URL('https://cdn.example.com/pic.png'),
    pinned: { address: '1.2.3.4', family: 4 },
  });

  mockGetRedis.mockReturnValue({ publish: vi.fn().mockResolvedValue(1) });
});

// ---------------------------------------------------------------------------
// Media URL fails SSRF validation
// ---------------------------------------------------------------------------

describe('POST /v1/messages, media URL fails SSRF validation', () => {
  it('returns 400 INVALID_CONTENT for an image body resolving to a private IP', async () => {
    mockResolveSafeHost.mockRejectedValueOnce(new Error('URL_PRIVATE_IP'));

    const res = await POST(makeRequest({ to: TO, body: IMAGE_BODY, purpose: PURPOSE }));
    expect(res.status).toBe(400);
    const resBody = (await res.json()) as { code: string };
    expect(resBody.code).toBe('INVALID_CONTENT');
  });

  it('returns 400 INVALID_CONTENT for a document body with a non-HTTPS URL', async () => {
    mockResolveSafeHost.mockRejectedValueOnce(new Error('URL_NOT_HTTPS'));

    const res = await POST(makeRequest({ to: TO, body: DOCUMENT_BODY, purpose: PURPOSE }));
    expect(res.status).toBe(400);
    const resBody = (await res.json()) as { code: string };
    expect(resBody.code).toBe('INVALID_CONTENT');
  });

  it('does not leak the internal SSRF failure reason in the response body', async () => {
    mockResolveSafeHost.mockRejectedValueOnce(new Error('URL_PRIVATE_IP'));

    const res = await POST(makeRequest({ to: TO, body: IMAGE_BODY, purpose: PURPOSE }));
    const rawBody = JSON.stringify(await res.json());

    expect(rawBody).not.toContain('URL_PRIVATE_IP');
    expect(rawBody).not.toContain('URL_NOT_HTTPS');
    expect(rawBody).not.toContain('URL_DNS_EMPTY');
    expect(rawBody).not.toContain('URL_NO_HOST');
    expect(rawBody).toContain('Media URL failed validation');
  });
});

// ---------------------------------------------------------------------------
// Media URL passes SSRF validation, legitimate sends are not blocked
// ---------------------------------------------------------------------------

describe('POST /v1/messages, media URL passes SSRF validation', () => {
  it('returns 202 queued for an image body with a safe URL', async () => {
    const res = await POST(makeRequest({ to: TO, body: IMAGE_BODY, purpose: PURPOSE }));
    expect(res.status).toBe(202);
    const resBody = (await res.json()) as { status: string; messageId: string };
    expect(resBody.status).toBe('queued');
    expect(typeof resBody.messageId).toBe('string');
    // A safe URL must pass the guard and reach publish, not just avoid the 400.
    expect(mockLpushPending).toHaveBeenCalledOnce();
  });

  // A second representative case for the document kind: the guard branches on
  // `body.kind === 'image' | 'document'` identically, so this confirms the
  // document arm resolves the same way rather than re-testing the whole send path.
  it('returns 202 queued for a document body with a safe URL', async () => {
    const res = await POST(makeRequest({ to: TO, body: DOCUMENT_BODY, purpose: PURPOSE }));
    expect(res.status).toBe(202);
    const resBody = (await res.json()) as { status: string; messageId: string };
    expect(resBody.status).toBe('queued');
    expect(typeof resBody.messageId).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// Text bodies skip the SSRF guard entirely
// ---------------------------------------------------------------------------

describe('POST /v1/messages, text body skips the SSRF guard', () => {
  it('never calls resolveSafeHost and still queues the send', async () => {
    const res = await POST(makeRequest({ to: TO, body: TEXT_BODY, purpose: PURPOSE }));

    expect(mockResolveSafeHost).not.toHaveBeenCalled();
    expect(res.status).toBe(202);
    const resBody = (await res.json()) as { status: string };
    expect(resBody.status).toBe('queued');
  });
});

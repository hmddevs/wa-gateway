/**
 * POST /v1/messages, organization routing branch.
 *
 * Asserts: an `orgId` key sends via the routed number (stamping and publishing
 * on that number, not the key's bound session); an outage returns 503 while an
 * out-of-budget organization returns 429 with Retry-After, the distinction
 * that makes a throttled number recoverable rather than a broken integration;
 * and a key with no `orgId` keeps the single-session path untouched.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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

vi.mock('@/lib/repositories/organizations', () => ({
  isOptedOutAcrossOrg: vi.fn().mockResolvedValue(false),
  getOrg: vi.fn(),
}));
vi.mock('@/lib/org-router', () => ({
  routeSend: vi.fn(),
}));
vi.mock('@/lib/session-state', () => ({
  refundSend: vi.fn().mockResolvedValue(undefined),
  retryAfterSeconds: () => 30,
}));

vi.mock('@/lib/rate-limit', () => ({
  checkRecipient: vi.fn().mockResolvedValue(true),
}));

vi.mock('@/lib/repositories/audit', () => ({
  appendAudit: vi.fn().mockResolvedValue(undefined),
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

import { POST } from '@/app/v1/messages/route';
import { authenticate, requireScope } from '@/lib/auth-api';
import { getCachedSession } from '@/lib/repositories/sessions';
import { routeSend } from '@/lib/org-router';
import { getRedis } from '@/lib/redis';
import { lpushPending } from '@/lib/wire';
import type { ApiKeyDoc } from '@/lib/repositories/api-keys';
import type { SessionDoc } from '@/lib/repositories/sessions';

const mockAuthenticate = authenticate as ReturnType<typeof vi.fn>;
const mockRequireScope = requireScope as ReturnType<typeof vi.fn>;
const mockGetCachedSession = getCachedSession as ReturnType<typeof vi.fn>;
const mockRouteSend = routeSend as ReturnType<typeof vi.fn>;
const mockGetRedis = getRedis as ReturnType<typeof vi.fn>;
const mockLpushPending = lpushPending as ReturnType<typeof vi.fn>;

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
    sessionId: 'bound-session',
    createdBy: 'admin@test.com',
    createdAt: new Date(),
    ...overrides,
  } as ApiKeyDoc;
}

function makeSession(sessionId: string, overrides: Partial<SessionDoc> = {}): SessionDoc {
  return {
    sessionId,
    workerId: 'worker-1',
    label: sessionId,
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

const publish = vi.fn().mockResolvedValue(1);

function makeRequest(body: unknown): Request {
  return new Request('https://wa.test/v1/messages', {
    method: 'POST',
    headers: { authorization: 'Bearer test-api-key', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireScope.mockReturnValue(true);
  mockGetRedis.mockReturnValue({ publish });
});

describe('POST /v1/messages, organization routing', () => {
  it('sends via the routed number, keyed by recipient for affinity', async () => {
    mockAuthenticate.mockResolvedValue({
      ok: true,
      apiKey: makeApiKey({ orgId: 'org-a' }),
      ip: '1.2.3.4',
      requestId: 'req-test',
    });
    mockRouteSend.mockResolvedValue({ ok: true, session: makeSession('org-a-02') });

    const res = await POST(makeRequest({ to: TO, body: TEXT_BODY, purpose: 'otp' }));
    expect(res.status).toBe(202);

    // Routed by (org, recipient), the recipient argument is what lets the
    // router keep a conversation on one number.
    expect(mockRouteSend).toHaveBeenCalledWith('org-a', TO);
    expect(mockGetCachedSession).not.toHaveBeenCalled();

    // Published and pushed on the ROUTED number, not the key's bound session.
    expect(mockLpushPending).toHaveBeenCalledWith('org-a-02', expect.any(String));
    expect(publish).toHaveBeenCalledWith('wa:outbound:org-a-02', expect.any(String));
  });

  it('returns 503 when no number is live, an outage, not a capacity limit', async () => {
    mockAuthenticate.mockResolvedValue({
      ok: true,
      apiKey: makeApiKey({ orgId: 'org-a' }),
      ip: '1.2.3.4',
      requestId: 'req-test',
    });
    mockRouteSend.mockResolvedValue({ ok: false, reason: 'no_healthy' });

    const res = await POST(makeRequest({ to: TO, body: TEXT_BODY, purpose: 'otp' }));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe('WORKER_UNAVAILABLE');
    expect(publish).not.toHaveBeenCalled();
  });

  it('returns 429 with Retry-After when every number is out of budget', async () => {
    mockAuthenticate.mockResolvedValue({
      ok: true,
      apiKey: makeApiKey({ orgId: 'org-a' }),
      ip: '1.2.3.4',
      requestId: 'req-test',
    });
    mockRouteSend.mockResolvedValue({ ok: false, reason: 'all_exhausted' });

    const res = await POST(makeRequest({ to: TO, body: TEXT_BODY, purpose: 'otp' }));
    // 429, not 503: the numbers are healthy, the organization is simply at its
    // send limit, and the caller can usefully retry.
    expect(res.status).toBe(429);
    expect(((await res.json()) as { code: string }).code).toBe('RATE_LIMITED');
    expect(res.headers.get('Retry-After')).toBe('30');
    expect(publish).not.toHaveBeenCalled();
  });

  it('keeps the single-session path when the key has no orgId', async () => {
    mockAuthenticate.mockResolvedValue({
      ok: true,
      apiKey: makeApiKey(),
      ip: '1.2.3.4',
      requestId: 'req-test',
    });
    mockGetCachedSession.mockResolvedValue(makeSession('bound-session'));

    const res = await POST(makeRequest({ to: TO, body: TEXT_BODY, purpose: 'otp' }));
    expect(res.status).toBe(202);

    expect(mockRouteSend).not.toHaveBeenCalled();
    expect(mockGetCachedSession).toHaveBeenCalledWith('bound-session');
    expect(mockLpushPending).toHaveBeenCalledWith('bound-session', expect.any(String));
    expect(publish).toHaveBeenCalledWith('wa:outbound:bound-session', expect.any(String));
  });
});

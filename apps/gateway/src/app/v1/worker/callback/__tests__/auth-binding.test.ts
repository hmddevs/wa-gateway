/**
 * POST /v1/worker/callback, W2.1 + W2.2 auth-hardening invariants.
 *
 * W2.1: the verified JWT identity (claims.workerId) must be bound to the
 *   envelope. A valid HMAC signature proves "a worker" (single shared
 *   WORKER_WIRE_SECRET), never "this worker", so the route must reject:
 *     - any envelope whose `workerId` differs from the token `sub`;
 *     - any envelope targeting a `sessionId` owned by a different worker.
 *   The legitimate single-worker case ('primary') must remain a no-op.
 *
 * W2.2: token type + generation binding.
 *     - bootstrap tokens are refresh-only and must never authorise a callback;
 *     - a refresh token whose `gen` is older than the worker's current
 *       `tokenGen` is stale and must be rejected (mirrors /v1/worker/refresh);
 *     - `gen === currentGen` (the live, freshly-rotated worker) is accepted.
 *
 * Mocked boundaries mirror chat-event.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/session-state', () => ({
  penaliseSession: vi.fn().mockResolvedValue(undefined),
  rewardSession: vi.fn().mockResolvedValue(undefined),
  refundSend: vi.fn().mockResolvedValue(undefined),
  retryAfterSeconds: () => 30,
}));
vi.mock('@/lib/worker-jwt', () => ({
  verifyWorkerJwt: vi.fn(),
}));

vi.mock('@/lib/wire', () => ({
  verify: vi.fn().mockResolvedValue(true),
  acceptNonce: vi.fn().mockResolvedValue(true),
  acceptInboundOnce: vi.fn().mockResolvedValue(true),
  acceptOnce: vi.fn().mockResolvedValue(true),
  isFreshTimestamp: vi.fn().mockReturnValue(true),
  sign: vi.fn(async (e) => ({ ...e, sig: 'signed' })),
  newNonce: vi.fn(() => 'nonce-x'),
  nowIso: vi.fn(() => new Date().toISOString()),
  lpushPending: vi.fn().mockResolvedValue(undefined),
  channels: { outbound: (id: string) => 'wa:outbound:' + id },
}));

vi.mock('@/lib/repositories/organizations', () => ({
  getOrgForSession: vi.fn().mockResolvedValue(null),
  isOptedOutAcrossOrg: vi.fn().mockResolvedValue(false),
}));

vi.mock('@/lib/redis', () => ({
  getRedis: vi.fn(() => ({ publish: vi.fn().mockResolvedValue(1) })),
  subscribeOnce: vi.fn(),
}));

vi.mock('@/lib/repositories/optout-pending', () => ({
  tryStartPendingOptOut: vi.fn().mockResolvedValue(true),
  clearPendingOptOut: vi.fn().mockResolvedValue(undefined),
  OPTOUT_CONFIRM_TTL_SECONDS: 1800,
}));

vi.mock('@/lib/repositories/worker-state', () => ({
  upsertWorker: vi.fn().mockResolvedValue(undefined),
  getWorker: vi.fn(),
  // The wire-path gen check reads getCachedWorker (5s TTL), so drive THAT to
  // exercise the real assertWorkerGenerationFresh logic.
  getCachedWorker: vi.fn(),
}));

vi.mock('@/lib/repositories/sessions', () => ({
  upsertSession: vi.fn().mockResolvedValue(undefined),
  updateSession: vi.fn().mockResolvedValue(undefined),
  getSession: vi.fn(),
  getCachedSession: vi.fn().mockResolvedValue(null),
  listSessionsByWorker: vi.fn().mockResolvedValue([]),
  invalidateSessionCache: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/repositories/optouts', () => ({
  addOptOut: vi.fn().mockResolvedValue(undefined),
  isOptedOut: vi.fn().mockResolvedValue(false),
}));

vi.mock('@/lib/repositories/messages', () => ({
  updateStatus: vi.fn().mockResolvedValue(undefined),
  findByMessageId: vi.fn().mockResolvedValue(null),
  findByWaMessageId: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/lib/repositories/audit', () => ({
  appendAudit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/repositories/api-keys', () => ({
  listKeysBySession: vi.fn().mockResolvedValue([]),
}));

vi.mock('@/lib/repositories/inbound-messages', () => ({
  insertInbound: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/repositories/chat-events', () => ({
  insertChatEvent: vi.fn().mockResolvedValue({ duplicate: false }),
}));

vi.mock('@/lib/repositories/message-revisions', () => ({
  insertRevisionFromEvent: vi
    .fn()
    .mockResolvedValue({ inserted: true, messageId: null, revisionSeq: 1 }),
}));

vi.mock('@/lib/repositories/contacts', () => ({
  upsertContactFromEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/repositories/message-reactions', () => ({
  upsertReactionFromEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/webhook-dispatch', () => ({
  dispatchEventBackground: vi.fn(),
}));

vi.mock('@/lib/admin-stream', () => ({
  publishAdminStream: vi.fn().mockResolvedValue(undefined),
  adminStreamChannel: vi.fn((id: string) => `admin:stream:${id}`),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { POST } from '@/app/v1/worker/callback/route';
import { verifyWorkerJwt } from '@/lib/worker-jwt';
import { getWorker, getCachedWorker } from '@/lib/repositories/worker-state';
import { getSession } from '@/lib/repositories/sessions';
import { insertChatEvent } from '@/lib/repositories/chat-events';

const mockVerifyWorkerJwt = verifyWorkerJwt as ReturnType<typeof vi.fn>;
const mockGetWorker = getWorker as ReturnType<typeof vi.fn>;
const mockGetCachedWorker = getCachedWorker as ReturnType<typeof vi.fn>;
const mockGetSession = getSession as ReturnType<typeof vi.fn>;
const mockInsertChatEvent = insertChatEvent as ReturnType<typeof vi.fn>;

const WORKER_ID = 'primary';
const SESSION_ID = 'session-a';

function makeChatEventRequest(overrides: Record<string, unknown> = {}): Request {
  const body = {
    v: 1,
    kind: 'chat_event',
    nonce: 'nonce-' + crypto.randomUUID(),
    at: new Date().toISOString(),
    sig: 'a'.repeat(64),
    workerId: WORKER_ID,
    sessionId: SESSION_ID,
    waMessageId: 'wa-' + crypto.randomUUID(),
    direction: 'out_device',
    source: 'live',
    counterpartyJid: '447700900000@s.whatsapp.net',
    counterpartyE164: '+447700900000',
    content: { kind: 'text', text: 'hi' },
    ts: new Date().toISOString(),
    ...overrides,
  };
  return new Request('https://wa.test/v1/worker/callback', {
    method: 'POST',
    headers: { authorization: 'Bearer worker-token', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockVerifyWorkerJwt.mockResolvedValue({
    workerId: WORKER_ID,
    typ: 'refresh',
    gen: 3,
    jti: 'jti-1',
  });
  mockGetWorker.mockResolvedValue({ workerId: WORKER_ID, status: 'connected', tokenGen: 3 });
  mockGetCachedWorker.mockResolvedValue({ workerId: WORKER_ID, status: 'connected', tokenGen: 3 });
  mockGetSession.mockResolvedValue({ sessionId: SESSION_ID, workerId: WORKER_ID });
  mockInsertChatEvent.mockResolvedValue({ duplicate: false });
});

describe('callback W2.1, envelope workerId binding', () => {
  it('accepts a matching workerId (live single-worker no-op)', async () => {
    const res = await POST(makeChatEventRequest());
    expect(res.status).toBe(200);
    expect(mockInsertChatEvent).toHaveBeenCalledOnce();
  });

  it('rejects an envelope whose workerId differs from the token sub', async () => {
    const res = await POST(makeChatEventRequest({ workerId: 'attacker' }));
    expect(res.status).toBe(403);
    expect(mockInsertChatEvent).not.toHaveBeenCalled();
  });
});

describe('callback W2.1, session ownership binding', () => {
  it('rejects when the target session is owned by a different worker', async () => {
    mockGetSession.mockResolvedValue({ sessionId: SESSION_ID, workerId: 'other-worker' });
    const res = await POST(makeChatEventRequest());
    expect(res.status).toBe(403);
    expect(mockInsertChatEvent).not.toHaveBeenCalled();
  });

  it('allows a callback for a session that does not yet exist (race / first contact)', async () => {
    mockGetSession.mockResolvedValue(null);
    const res = await POST(makeChatEventRequest());
    expect(res.status).toBe(200);
    expect(mockInsertChatEvent).toHaveBeenCalledOnce();
  });
});

describe('callback W2.2, token type + generation', () => {
  it('rejects a bootstrap token', async () => {
    mockVerifyWorkerJwt.mockResolvedValue({ workerId: WORKER_ID, typ: 'bootstrap', jti: 'jti-b' });
    const res = await POST(makeChatEventRequest());
    expect(res.status).toBe(401);
    expect(mockInsertChatEvent).not.toHaveBeenCalled();
  });

  it('rejects a refresh token with gen < currentGen', async () => {
    mockVerifyWorkerJwt.mockResolvedValue({
      workerId: WORKER_ID,
      typ: 'refresh',
      gen: 2,
      jti: 'jti-old',
    });
    mockGetCachedWorker.mockResolvedValue({ workerId: WORKER_ID, tokenGen: 3 });
    const res = await POST(makeChatEventRequest());
    expect(res.status).toBe(401);
    expect(mockInsertChatEvent).not.toHaveBeenCalled();
  });

  it('accepts a refresh token with gen === currentGen (live worker)', async () => {
    mockVerifyWorkerJwt.mockResolvedValue({
      workerId: WORKER_ID,
      typ: 'refresh',
      gen: 3,
      jti: 'jti-cur',
    });
    mockGetCachedWorker.mockResolvedValue({ workerId: WORKER_ID, tokenGen: 3 });
    const res = await POST(makeChatEventRequest());
    expect(res.status).toBe(200);
    expect(mockInsertChatEvent).toHaveBeenCalledOnce();
  });

  it('accepts a refresh token with gen > currentGen (gateway state lagging)', async () => {
    mockVerifyWorkerJwt.mockResolvedValue({
      workerId: WORKER_ID,
      typ: 'refresh',
      gen: 5,
      jti: 'jti-new',
    });
    mockGetCachedWorker.mockResolvedValue({ workerId: WORKER_ID, tokenGen: 3 });
    const res = await POST(makeChatEventRequest());
    expect(res.status).toBe(200);
    expect(mockInsertChatEvent).toHaveBeenCalledOnce();
  });

  it('FAILS OPEN when the generation lookup errors (infra blip must not 401 a live worker)', async () => {
    // The safety invariant: a DB/Redis failure in the gen check must never take
    // the live workers offline. Only a deliberate RevokedTokenError 401s.
    mockVerifyWorkerJwt.mockResolvedValue({
      workerId: WORKER_ID,
      typ: 'refresh',
      gen: 3,
      jti: 'jti-cur',
    });
    mockGetCachedWorker.mockRejectedValueOnce(new Error('redis down'));
    const res = await POST(makeChatEventRequest());
    expect(res.status).toBe(200);
    expect(mockInsertChatEvent).toHaveBeenCalledOnce();
  });
});

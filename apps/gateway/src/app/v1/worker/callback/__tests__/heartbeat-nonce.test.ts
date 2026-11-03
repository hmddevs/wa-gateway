/**
 * POST /v1/worker/callback, heartbeat nonce split.
 *
 * `kind: 'heartbeat'` envelopes dedup their nonce via an in-process Map
 * (`acceptHeartbeatNonce`) instead of the Redis-backed `acceptNonce`, see the
 * rationale comment on `acceptHeartbeatNonce` in `@/lib/wire`. Every other
 * envelope kind must be unaffected and keep hitting the Redis SET NX EX path.
 *
 * Unlike the other callback route tests, this file does NOT stub out
 * `acceptNonce`/`acceptHeartbeatNonce`, it uses the real implementations
 * from `@/lib/wire` (only `verify`/`sign`/nonce-adjacent helpers unrelated to
 * this split are stubbed) so the actual dedup logic is exercised. `@/lib/redis`
 * is mocked so Redis usage (or its absence) can be asserted directly.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// wire.ts is only partially mocked below (real acceptNonce/acceptHeartbeatNonce
// are kept), so it loads the real @/lib/env module-init validation unless
// stubbed here.
vi.mock('@/lib/session-state', () => ({
  penaliseSession: vi.fn().mockResolvedValue(undefined),
  rewardSession: vi.fn().mockResolvedValue(undefined),
  refundSend: vi.fn().mockResolvedValue(undefined),
  retryAfterSeconds: () => 30,
}));
vi.mock('@/lib/env', () => ({
  env: { WORKER_WIRE_SECRET: Buffer.alloc(32).toString('base64') },
}));

vi.mock('@/lib/worker-jwt', () => ({
  verifyWorkerJwt: vi.fn(),
}));

const redisSet = vi.fn().mockResolvedValue('OK');
vi.mock('@/lib/redis', () => ({
  getRedis: vi.fn(() => ({ set: redisSet, publish: vi.fn().mockResolvedValue(1) })),
}));

vi.mock('@/lib/wire', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/wire')>();
  return {
    ...actual,
    // Real acceptNonce / acceptHeartbeatNonce are kept so this test exercises
    // the genuine dedup behaviour; only signing/verification is stubbed.
    verify: vi.fn().mockResolvedValue(true),
    sign: vi.fn(async (e: Record<string, unknown>) => ({ ...e, sig: 'signed' })),
    newNonce: vi.fn(() => 'nonce-x'),
    nowIso: vi.fn(() => new Date().toISOString()),
    lpushPending: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('@/lib/repositories/organizations', () => ({
  getOrgForSession: vi.fn().mockResolvedValue(null),
  isOptedOutAcrossOrg: vi.fn().mockResolvedValue(false),
}));

vi.mock('@/lib/repositories/optout-pending', () => ({
  tryStartPendingOptOut: vi.fn().mockResolvedValue(true),
  clearPendingOptOut: vi.fn().mockResolvedValue(undefined),
  OPTOUT_CONFIRM_TTL_SECONDS: 1800,
}));

vi.mock('@/lib/repositories/worker-state', () => ({
  upsertWorker: vi.fn().mockResolvedValue(undefined),
  getWorker: vi.fn(),
  getCachedWorker: vi.fn().mockResolvedValue({ workerId: 'primary', tokenGen: 3 }),
}));

vi.mock('@/lib/repositories/sessions', () => ({
  upsertSession: vi.fn().mockResolvedValue(undefined),
  updateSession: vi.fn().mockResolvedValue(undefined),
  getSession: vi.fn().mockResolvedValue({ sessionId: 'session-a', workerId: 'primary' }),
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

const mockVerifyWorkerJwt = verifyWorkerJwt as ReturnType<typeof vi.fn>;

const WORKER_ID = 'primary';
const SESSION_ID = 'session-a';

function heartbeatBody(overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    kind: 'heartbeat',
    nonce: 'nonce-' + crypto.randomUUID(),
    at: new Date().toISOString(),
    sig: 'a'.repeat(64),
    workerId: WORKER_ID,
    sessionId: SESSION_ID,
    status: 'connected',
    ...overrides,
  };
}

function chatEventBody(overrides: Record<string, unknown> = {}) {
  return {
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
}

function makeRequest(body: Record<string, unknown>): Request {
  return new Request('https://wa.test/v1/worker/callback', {
    method: 'POST',
    headers: { authorization: 'Bearer worker-token', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  redisSet.mockResolvedValue('OK');
  mockVerifyWorkerJwt.mockResolvedValue({
    workerId: WORKER_ID,
    typ: 'refresh',
    gen: 3,
    jti: 'jti-1',
  });
});

describe('heartbeat nonce dedup (in-process, no Redis)', () => {
  it('accepts the first heartbeat and never touches Redis', async () => {
    const body = heartbeatBody();
    const res = await POST(makeRequest(body));

    expect(res.status).toBe(200);
    expect(redisSet).not.toHaveBeenCalled();
  });

  it('rejects a replayed heartbeat nonce (409) without touching Redis', async () => {
    const body = heartbeatBody();

    const first = await POST(makeRequest(body));
    expect(first.status).toBe(200);

    const replay = await POST(makeRequest(body)); // identical nonce
    expect(replay.status).toBe(409);
    expect(redisSet).not.toHaveBeenCalled();
  });

  it('a fresh nonce for a subsequent heartbeat is accepted', async () => {
    const first = await POST(makeRequest(heartbeatBody()));
    const second = await POST(makeRequest(heartbeatBody())); // distinct nonce

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
  });
});

describe('non-heartbeat kinds keep the Redis nonce path', () => {
  it('a chat_event envelope dedups its nonce via Redis SET NX EX', async () => {
    const body = chatEventBody();
    const res = await POST(makeRequest(body));

    expect(res.status).toBe(200);
    expect(redisSet).toHaveBeenCalledWith(`wa:nonce:${body.nonce}`, '1', 'EX', 600, 'NX');
  });

  it('rejects a replayed chat_event nonce when Redis reports it already exists', async () => {
    redisSet.mockResolvedValue(null); // ioredis: NX key already exists

    const res = await POST(makeRequest(chatEventBody()));

    expect(res.status).toBe(409);
  });
});

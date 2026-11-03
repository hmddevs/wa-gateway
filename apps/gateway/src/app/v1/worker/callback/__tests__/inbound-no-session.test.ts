/**
 * POST /v1/worker/callback, inbound without resolvable sessionId.
 *
 * Verifies the route's new policy: when the worker omits `sessionId` AND
 * `listSessionsByWorker` returns 0 or >1 sessions, the inbound is dropped
 * (no persist, no admin SSE, no webhook dispatch). This replaces the older
 * behaviour that persisted with `sessionId: ''`, empty-string sessionIds
 * pollute the (sessionId, *) indexes and the row is invisible to the admin
 * viewer anyway.
 *
 * Mocked boundaries, same as `inbound-happy.test.ts`.
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
  getWorker: vi.fn().mockResolvedValue(null),
  getCachedWorker: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/lib/repositories/sessions', () => ({
  upsertSession: vi.fn().mockResolvedValue(undefined),
  updateSession: vi.fn().mockResolvedValue(undefined),
  getSession: vi.fn(),
  getCachedSession: vi.fn().mockResolvedValue(null),
  listSessionsByWorker: vi.fn().mockResolvedValue([]),
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
  insertRevisionFromEvent: vi.fn().mockResolvedValue({
    inserted: true,
    messageId: null,
    revisionSeq: 1,
  }),
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

vi.mock('@/lib/cron-auth', () => ({ isCronAuthorized: vi.fn().mockReturnValue(true) }));
vi.mock('@/app/api/cron/worker-watchdog/route', () => ({
  flipToOffline: vi.fn().mockResolvedValue(undefined),
  runWatchdog: vi.fn(),
  HEARTBEAT_TIMEOUT_MS: 60_000,
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { POST } from '@/app/v1/worker/callback/route';
import { verifyWorkerJwt } from '@/lib/worker-jwt';
import { listSessionsByWorker } from '@/lib/repositories/sessions';
import { insertInbound } from '@/lib/repositories/inbound-messages';
import { publishAdminStream } from '@/lib/admin-stream';
import { dispatchEventBackground } from '@/lib/webhook-dispatch';
import { logger } from '@/lib/logger';

const mockVerifyWorkerJwt = verifyWorkerJwt as ReturnType<typeof vi.fn>;
const mockListSessions = listSessionsByWorker as ReturnType<typeof vi.fn>;
const mockInsertInbound = insertInbound as ReturnType<typeof vi.fn>;
const mockPublishAdminStream = publishAdminStream as ReturnType<typeof vi.fn>;
const mockDispatch = dispatchEventBackground as ReturnType<typeof vi.fn>;
const mockWarn = logger.warn as ReturnType<typeof vi.fn>;

const WORKER_ID = 'worker-1';

function makeInboundWithoutSessionId(): Request {
  const body = {
    v: 1,
    kind: 'inbound',
    nonce: 'nonce-' + crypto.randomUUID(),
    at: new Date().toISOString(),
    sig: 'a'.repeat(64),
    workerId: WORKER_ID,
    // sessionId intentionally omitted
    waMessageId: 'wa-inbound-no-session-001',
    from: '447700900456@s.whatsapp.net',
    body: { kind: 'text', text: 'Hello' },
  };
  return new Request('https://wa.test/v1/worker/callback', {
    method: 'POST',
    headers: {
      authorization: 'Bearer worker-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockVerifyWorkerJwt.mockResolvedValue({
    workerId: WORKER_ID,
    typ: 'refresh',
    jti: 'jti-1',
  });
});

describe('callback inbound, missing sessionId, no sessions for worker', () => {
  it('returns 200 but skips persistence, admin stream, and dispatch', async () => {
    mockListSessions.mockResolvedValueOnce([]);
    const res = await POST(makeInboundWithoutSessionId());
    expect(res.status).toBe(200);
    expect(mockInsertInbound).not.toHaveBeenCalled();
    expect(mockPublishAdminStream).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({ workerId: WORKER_ID }),
      expect.stringContaining('inbound without resolvable sessionId'),
    );
  });
});

describe('callback inbound, missing sessionId, multiple sessions for worker', () => {
  it('returns 200 but skips persistence, admin stream, and dispatch (ambiguous)', async () => {
    mockListSessions.mockResolvedValueOnce([
      { sessionId: 'a', workerId: WORKER_ID },
      { sessionId: 'b', workerId: WORKER_ID },
    ]);
    const res = await POST(makeInboundWithoutSessionId());
    expect(res.status).toBe(200);
    expect(mockInsertInbound).not.toHaveBeenCalled();
    expect(mockPublishAdminStream).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalled();
  });
});

describe('callback inbound, missing sessionId, exactly one session for worker', () => {
  it('resolves session via listSessionsByWorker and persists with the resolved id', async () => {
    mockListSessions.mockResolvedValueOnce([
      { sessionId: 'resolved-session', workerId: WORKER_ID },
    ]);
    const res = await POST(makeInboundWithoutSessionId());
    expect(res.status).toBe(200);
    expect(mockInsertInbound).toHaveBeenCalledOnce();
    const doc = mockInsertInbound.mock.calls[0]![0] as { sessionId: string };
    expect(doc.sessionId).toBe('resolved-session');
    expect(mockWarn).not.toHaveBeenCalled();
  });
});

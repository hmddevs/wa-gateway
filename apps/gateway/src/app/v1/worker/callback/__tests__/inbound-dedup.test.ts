/**
 * POST /v1/worker/callback, inbound dedup across linked devices.
 *
 * Two WhatsApp linked devices of the same number (the primary and a backup
 * worker) both receive every inbound and both report it under different
 * sessionIds. The route claims the inbound once via `acceptInboundOnce` (SET NX
 * on waMessageId), so the side effects (persist, admin SSE, webhook fan-out)
 * run exactly once. A Redis error on the claim fails OPEN (processes), so a real
 * inbound is never dropped.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/session-state', () => ({
  penaliseSession: vi.fn().mockResolvedValue(undefined),
  rewardSession: vi.fn().mockResolvedValue(undefined),
  refundSend: vi.fn().mockResolvedValue(undefined),
  retryAfterSeconds: () => 30,
}));
vi.mock('@/lib/worker-jwt', () => ({ verifyWorkerJwt: vi.fn() }));

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
vi.mock('@/lib/repositories/audit', () => ({ appendAudit: vi.fn().mockResolvedValue(undefined) }));
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
vi.mock('@/lib/webhook-dispatch', () => ({ dispatchEventBackground: vi.fn() }));
vi.mock('@/lib/admin-stream', () => ({
  publishAdminStream: vi.fn().mockResolvedValue(undefined),
  adminStreamChannel: vi.fn((id: string) => `admin:stream:${id}`),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { POST } from '@/app/v1/worker/callback/route';
import { verifyWorkerJwt } from '@/lib/worker-jwt';
import { acceptInboundOnce } from '@/lib/wire';
import { insertInbound } from '@/lib/repositories/inbound-messages';
import { publishAdminStream } from '@/lib/admin-stream';

const mockVerifyWorkerJwt = verifyWorkerJwt as ReturnType<typeof vi.fn>;
const mockAcceptInboundOnce = acceptInboundOnce as ReturnType<typeof vi.fn>;
const mockInsertInbound = insertInbound as ReturnType<typeof vi.fn>;
const mockPublishAdminStream = publishAdminStream as ReturnType<typeof vi.fn>;

/** Two linked devices report the SAME message under different sessionIds. */
function makeInboundRequest(sessionId: string, waMessageId = 'wa-dup-001'): Request {
  const body = {
    v: 1,
    kind: 'inbound',
    nonce: 'nonce-' + crypto.randomUUID(),
    at: new Date().toISOString(),
    sig: 'a'.repeat(64),
    workerId: 'worker-1',
    sessionId,
    waMessageId,
    from: '447700900456@s.whatsapp.net',
    body: { kind: 'text', text: 'Hello' },
  };
  return new Request('https://wa.test/v1/worker/callback', {
    method: 'POST',
    headers: { authorization: 'Bearer worker-token', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockVerifyWorkerJwt.mockResolvedValue({ workerId: 'worker-1', typ: 'refresh', jti: 'jti-1' });
});

describe('callback inbound dedup', () => {
  it('processes the first report and skips the duplicate from the second linked device', async () => {
    // First device claims the message (true); second device loses the race (false).
    mockAcceptInboundOnce.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    const first = await POST(makeInboundRequest('session-a'));
    const second = await POST(makeInboundRequest('m1-session')); // same waMessageId

    expect(first.status).toBe(200);
    expect(second.status).toBe(200); // the loser still gets a clean ack, not a retry
    expect(mockInsertInbound).toHaveBeenCalledOnce();
    expect(mockPublishAdminStream).toHaveBeenCalledOnce();
  });

  it('processes two genuinely different inbound messages', async () => {
    mockAcceptInboundOnce.mockResolvedValue(true);

    await POST(makeInboundRequest('session-a', 'wa-aaa'));
    await POST(makeInboundRequest('session-a', 'wa-bbb'));

    expect(mockInsertInbound).toHaveBeenCalledTimes(2);
  });

  it('fails OPEN and still processes when the dedup claim errors', async () => {
    mockAcceptInboundOnce.mockRejectedValueOnce(new Error('redis down'));

    const res = await POST(makeInboundRequest('session-a'));

    expect(res.status).toBe(200);
    expect(mockInsertInbound).toHaveBeenCalledOnce(); // not dropped
  });
});

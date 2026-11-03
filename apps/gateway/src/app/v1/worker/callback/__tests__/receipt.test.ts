/**
 * POST /v1/worker/callback, receipt handler (rewritten).
 *
 * Covers the five behaviours added when receipts gained waMessageId resolution,
 * pool normalisation, cross-device dedup, and legacy messageId fall-through.
 *
 *   1. Resolves by (sessionId, waMessageId) when no messageId is present;
 *      dispatches a message.delivered webhook; findByMessageId is NOT called.
 *   2. Organization normalisation: findByWaMessageId receives the organization HEAD sessionId,
 *      not the backup device sessionId that arrived in the envelope.
 *   3. Cross-device dedup: updateStatus runs on EVERY receipt (idempotent);
 *      dispatchEventBackground fires only ONCE (acceptOnce gates the webhook).
 *   4. Unknown message (both lookups null): no updateStatus, no dispatch, 200.
 *   5. Legacy path: receipt with messageId only uses findByMessageId;
 *      findByWaMessageId is NOT called.
 *
 * Mocked boundaries mirror auth-binding.test.ts and inbound-happy.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- module mocks -----------------------------------------------------------

vi.mock('@/lib/worker-jwt', () => ({
  verifyWorkerJwt: vi.fn(),
}));

vi.mock('@/lib/worker-auth', () => ({
  assertWorkerGenerationFresh: vi.fn().mockResolvedValue(undefined),
  RevokedTokenError: class RevokedTokenError extends Error {},
}));

vi.mock('@/lib/wire', () => ({
  verify: vi.fn().mockResolvedValue(true),
  acceptNonce: vi.fn().mockResolvedValue(true),
  acceptInboundOnce: vi.fn().mockResolvedValue(true),
  acceptOnce: vi.fn().mockResolvedValue(true),
  isFreshTimestamp: vi.fn().mockReturnValue(true),
  sign: vi.fn(async (e: Record<string, unknown>) => ({ ...e, sig: 'signed' })),
  newNonce: vi.fn(() => 'nonce-x'),
  nowIso: vi.fn(() => new Date().toISOString()),
  lpushPending: vi.fn().mockResolvedValue(undefined),
  channels: { outbound: (id: string) => `wa:outbound:${id}` },
}));

vi.mock('@/lib/session-state', () => ({
  penaliseSession: vi.fn().mockResolvedValue(undefined),
  rewardSession: vi.fn().mockResolvedValue(undefined),
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
  getSession: vi.fn().mockResolvedValue(null),
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

// ---- imports after mocks ----------------------------------------------------

import { POST } from '@/app/v1/worker/callback/route';
import { verifyWorkerJwt } from '@/lib/worker-jwt';
import { acceptOnce } from '@/lib/wire';
import { getOrgForSession } from '@/lib/repositories/organizations';
import { findByMessageId, findByWaMessageId, updateStatus } from '@/lib/repositories/messages';
import { dispatchEventBackground } from '@/lib/webhook-dispatch';
import { publishAdminStream } from '@/lib/admin-stream';

// ---------------------------------------------------------------------------
// Typed mock references
// ---------------------------------------------------------------------------

const mockVerifyWorkerJwt = verifyWorkerJwt as ReturnType<typeof vi.fn>;
const mockAcceptOnce = acceptOnce as ReturnType<typeof vi.fn>;
const mockGetOrgForSession = getOrgForSession as ReturnType<typeof vi.fn>;
const mockFindByMessageId = findByMessageId as ReturnType<typeof vi.fn>;
const mockFindByWaMessageId = findByWaMessageId as ReturnType<typeof vi.fn>;
const mockUpdateStatus = updateStatus as ReturnType<typeof vi.fn>;
const mockDispatch = dispatchEventBackground as ReturnType<typeof vi.fn>;
const mockPublishAdminStream = publishAdminStream as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WORKER_ID = 'worker-1';
const PRIMARY_SESSION = 'example-service';
const BACKUP_SESSION = 'example-service-backup';
const ORG_ID = 'example-service-org';

const ORG_DOC = {
  orgId: ORG_ID,
  sessions: [PRIMARY_SESSION, BACKUP_SESSION],
  strategy: 'priority' as const,
};

/** A resolved message document. */
const MSG_DOC = {
  messageId: 'gw-1',
  sessionId: PRIMARY_SESSION,
  waMessageId: 'wa-1',
  apiKeyId: 'k1',
};

// ---------------------------------------------------------------------------
// Request builder
// ---------------------------------------------------------------------------

function makeReceiptRequest(overrides: Record<string, unknown> = {}): Request {
  const body = {
    v: 1,
    kind: 'receipt',
    nonce: 'nonce-' + crypto.randomUUID(),
    at: new Date().toISOString(),
    sig: 'a'.repeat(64),
    status: 'delivered',
    ...overrides,
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

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockVerifyWorkerJwt.mockResolvedValue({
    workerId: WORKER_ID,
    typ: 'refresh',
    gen: 3,
    jti: 'jti-1',
  });
  mockAcceptOnce.mockResolvedValue(true);
  mockGetOrgForSession.mockResolvedValue(null);
  mockFindByMessageId.mockResolvedValue(null);
  mockFindByWaMessageId.mockResolvedValue(null);
});

// ---------------------------------------------------------------------------
// 1. Resolves by (sessionId, waMessageId) when no messageId present
// ---------------------------------------------------------------------------

describe('receipt, resolves by waMessageId when messageId absent', () => {
  it('calls updateStatus with the gateway messageId and dispatches message.delivered', async () => {
    mockFindByWaMessageId.mockResolvedValue(MSG_DOC);

    const res = await POST(
      makeReceiptRequest({
        waMessageId: 'wa-1',
        sessionId: PRIMARY_SESSION,
        status: 'delivered',
      }),
    );

    expect(res.status).toBe(200);

    // updateStatus must have been called with the resolved gateway id.
    expect(mockUpdateStatus).toHaveBeenCalledOnce();
    expect(mockUpdateStatus.mock.calls[0]![0]).toBe('gw-1');

    // A message.delivered webhook must have been dispatched exactly once.
    expect(mockDispatch).toHaveBeenCalledOnce();
    const event = mockDispatch.mock.calls[0]![0] as {
      type: string;
      messageId: string;
      waMessageId: string;
    };
    expect(event.type).toBe('message.delivered');
    expect(event.messageId).toBe('gw-1');
    expect(event.waMessageId).toBe('wa-1');

    // findByMessageId must NOT have been called (no messageId in the envelope).
    expect(mockFindByMessageId).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 2. Organization normalisation: findByWaMessageId receives the organization HEAD sessionId
// ---------------------------------------------------------------------------

describe('receipt, pool normalisation uses pool head for waMessageId lookup', () => {
  it('calls findByWaMessageId with the pool-head sessionId, not the backup device id', async () => {
    mockGetOrgForSession.mockResolvedValue(ORG_DOC);
    mockFindByWaMessageId.mockResolvedValue({
      messageId: 'gw-2',
      sessionId: PRIMARY_SESSION,
      waMessageId: 'wa-2',
      apiKeyId: 'k2',
    });

    const res = await POST(
      makeReceiptRequest({
        waMessageId: 'wa-2',
        sessionId: BACKUP_SESSION,
        status: 'delivered',
      }),
    );

    expect(res.status).toBe(200);

    // The repo must have been queried against the pool head, not the m1 id.
    expect(mockFindByWaMessageId).toHaveBeenCalledOnce();
    expect(mockFindByWaMessageId.mock.calls[0]![0]).toBe(PRIMARY_SESSION);
    expect(mockFindByWaMessageId.mock.calls[0]![1]).toBe('wa-2');
  });
});

// ---------------------------------------------------------------------------
// 3. Cross-device dedup: updateStatus runs both times; dispatch fires once
// ---------------------------------------------------------------------------

describe('receipt, cross-device dedup gates webhook but not updateStatus', () => {
  it('calls updateStatus on both receipts but dispatches the webhook only once', async () => {
    mockFindByWaMessageId.mockResolvedValue(MSG_DOC);
    // First call accepted, second rejected by the dedup key.
    mockAcceptOnce.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    const makeReq = () =>
      makeReceiptRequest({
        waMessageId: 'wa-1',
        sessionId: PRIMARY_SESSION,
        status: 'read',
      });

    const res1 = await POST(makeReq());
    const res2 = await POST(makeReq());

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    // updateStatus must have run for both calls.
    expect(mockUpdateStatus).toHaveBeenCalledTimes(2);

    // SSE + webhook dispatched only once (first device wins).
    expect(mockDispatch).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// 4. Unknown message: no updateStatus, no dispatch, returns 200
// ---------------------------------------------------------------------------

describe('receipt, unknown message skips all side-effects', () => {
  it('returns 200 without calling updateStatus or dispatchEventBackground', async () => {
    // Both lookup strategies return null, message not found.
    mockFindByMessageId.mockResolvedValue(null);
    mockFindByWaMessageId.mockResolvedValue(null);

    const res = await POST(
      makeReceiptRequest({
        waMessageId: 'wa-unknown',
        sessionId: PRIMARY_SESSION,
        status: 'delivered',
      }),
    );

    expect(res.status).toBe(200);
    expect(mockUpdateStatus).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 5. Legacy path: messageId only resolves via findByMessageId
// ---------------------------------------------------------------------------

describe('receipt, legacy messageId field uses findByMessageId, not findByWaMessageId', () => {
  it('resolves via findByMessageId and does not call findByWaMessageId', async () => {
    const legacyDoc = {
      messageId: 'gw-9',
      sessionId: PRIMARY_SESSION,
      waMessageId: 'wa-9',
      apiKeyId: 'k9',
    };
    mockFindByMessageId.mockResolvedValue(legacyDoc);

    const res = await POST(
      makeReceiptRequest({
        messageId: 'gw-9',
        status: 'delivered',
      }),
    );

    expect(res.status).toBe(200);

    // findByMessageId must have been called with the legacy id.
    expect(mockFindByMessageId).toHaveBeenCalledOnce();
    expect(mockFindByMessageId.mock.calls[0]![0]).toBe('gw-9');

    // findByWaMessageId must NOT have been called (messageId took the fast path).
    expect(mockFindByWaMessageId).not.toHaveBeenCalled();

    // Status must have been updated.
    expect(mockUpdateStatus).toHaveBeenCalledOnce();
    expect(mockUpdateStatus.mock.calls[0]![0]).toBe('gw-9');

    // Webhook must have been dispatched with the correct waMessageId.
    expect(mockDispatch).toHaveBeenCalledOnce();
    const event = mockDispatch.mock.calls[0]![0] as { type: string; waMessageId: string };
    expect(event.type).toBe('message.delivered');
    expect(event.waMessageId).toBe('wa-9');
  });
});

// ---------------------------------------------------------------------------
// Extra: publishAdminStream fires on the resolved message's sessionId
// ---------------------------------------------------------------------------

describe('receipt, publishAdminStream uses the resolved message sessionId', () => {
  it('publishes an admin stream event with kind message_status and the correct sessionId', async () => {
    mockFindByWaMessageId.mockResolvedValue(MSG_DOC);

    await POST(
      makeReceiptRequest({
        waMessageId: 'wa-1',
        sessionId: PRIMARY_SESSION,
        status: 'delivered',
      }),
    );

    expect(mockPublishAdminStream).toHaveBeenCalledOnce();
    const payload = mockPublishAdminStream.mock.calls[0]![0] as {
      kind: string;
      sessionId: string;
      messageId: string;
      status: string;
    };
    expect(payload.kind).toBe('message_status');
    expect(payload.sessionId).toBe(PRIMARY_SESSION);
    expect(payload.messageId).toBe('gw-1');
    expect(payload.status).toBe('delivered');
  });
});

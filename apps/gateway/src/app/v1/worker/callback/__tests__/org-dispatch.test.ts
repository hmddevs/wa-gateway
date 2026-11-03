/**
 * POST /v1/worker/callback, pool-aware dispatch behaviour.
 *
 * Covers four behaviours introduced when the route gained `resolveDispatch`:
 *
 *   1. POOLED INBOUND NORMALIZATION, an inbound arriving under the backup
 *      device's sessionId is normalised to the pool-head sessionId before
 *      persistence, SSE, webhook fan-out and key lookup.
 *
 *   2. UNGROUPED PASSTHROUGH, a solo session (getOrgForSession → null)
 *      dispatches under its own id unchanged.
 *
 *   3. OPT-OUT POOL-SCOPED HANDSHAKE, the two STOP steps can arrive under
 *      different device sessionIds but share one pending window keyed on the
 *      orgId.
 *
 *   4. REACTION CROSS-DEVICE DEDUP, acceptOnce gates the webhook fan-out;
 *      upsertReactionFromEvent is allowed to run on every delivery.
 *
 * Mocked boundaries: same full set as keyword-optout.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- module mocks -----------------------------------------------------------

vi.mock('@/lib/worker-jwt', () => ({
  verifyWorkerJwt: vi.fn(),
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

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ---- imports after mocks ----------------------------------------------------

import { POST } from '@/app/v1/worker/callback/route';
import { verifyWorkerJwt } from '@/lib/worker-jwt';
import { acceptOnce } from '@/lib/wire';
import { getOrgForSession, isOptedOutAcrossOrg } from '@/lib/repositories/organizations';
import { insertInbound } from '@/lib/repositories/inbound-messages';
import { listKeysBySession } from '@/lib/repositories/api-keys';
import { dispatchEventBackground } from '@/lib/webhook-dispatch';
import { publishAdminStream } from '@/lib/admin-stream';
import { upsertReactionFromEvent } from '@/lib/repositories/message-reactions';
import { tryStartPendingOptOut, clearPendingOptOut } from '@/lib/repositories/optout-pending';
import { addOptOut, isOptedOut } from '@/lib/repositories/optouts';
import { getSession } from '@/lib/repositories/sessions';
import type { SessionDoc } from '@/lib/repositories/sessions';

// ---------------------------------------------------------------------------
// Typed mock references
// ---------------------------------------------------------------------------

const mockVerifyWorkerJwt = verifyWorkerJwt as ReturnType<typeof vi.fn>;
const mockGetOrgForSession = getOrgForSession as ReturnType<typeof vi.fn>;
const mockIsOptedOutAcrossOrg = isOptedOutAcrossOrg as ReturnType<typeof vi.fn>;
const mockAcceptOnce = acceptOnce as ReturnType<typeof vi.fn>;
const mockInsertInbound = insertInbound as ReturnType<typeof vi.fn>;
const mockListKeysBySession = listKeysBySession as ReturnType<typeof vi.fn>;
const mockDispatch = dispatchEventBackground as ReturnType<typeof vi.fn>;
const mockPublishAdminStream = publishAdminStream as ReturnType<typeof vi.fn>;
const mockUpsertReaction = upsertReactionFromEvent as ReturnType<typeof vi.fn>;
const mockTryStart = tryStartPendingOptOut as ReturnType<typeof vi.fn>;
const mockClearPending = clearPendingOptOut as ReturnType<typeof vi.fn>;
const mockAddOptOut = addOptOut as ReturnType<typeof vi.fn>;
const mockIsOptedOut = isOptedOut as ReturnType<typeof vi.fn>;
const mockGetSession = getSession as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WORKER_ID = 'worker-1';
const PRIMARY_SESSION = 'example-service';
const BACKUP_SESSION = 'example-service-backup';
const ORG_ID = 'example-service-org';
const SOLO_SESSION = 'solo-session';

const ORG_DOC = {
  orgId: ORG_ID,
  sessions: [PRIMARY_SESSION, BACKUP_SESSION],
  strategy: 'priority' as const,
};

// ---------------------------------------------------------------------------
// Request builders
// ---------------------------------------------------------------------------

function makeInboundRequest(sessionId: string, text = 'Hello'): Request {
  const body = {
    v: 1,
    kind: 'inbound',
    nonce: 'nonce-' + crypto.randomUUID(),
    at: new Date().toISOString(),
    sig: 'a'.repeat(64),
    workerId: WORKER_ID,
    sessionId,
    waMessageId: 'wa-pool-test-001',
    from: '447700900999@s.whatsapp.net',
    body: { kind: 'text', text },
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

function makeReactionRequest(sessionId: string, waMessageId = 'BAE5REACT0001'): Request {
  const body = {
    v: 1,
    kind: 'reaction',
    nonce: 'nonce-' + crypto.randomUUID(),
    at: new Date().toISOString(),
    sig: 'a'.repeat(64),
    workerId: WORKER_ID,
    sessionId,
    targetWaMessageId: waMessageId,
    targetFromMe: true,
    from: '+447700900000',
    fromJid: '447700900000@s.whatsapp.net',
    emoji: '👍',
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

function makeSession(sessionId: string): SessionDoc {
  return {
    sessionId,
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
  } as SessionDoc;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockVerifyWorkerJwt.mockResolvedValue({ workerId: WORKER_ID, typ: 'refresh', jti: 'jti-1' });
  mockInsertInbound.mockResolvedValue(undefined);
  mockListKeysBySession.mockResolvedValue([]);
  mockIsOptedOut.mockResolvedValue(false);
  mockIsOptedOutAcrossOrg.mockResolvedValue(false);
  mockTryStart.mockResolvedValue(true);
  mockClearPending.mockResolvedValue(undefined);
  mockAddOptOut.mockResolvedValue(undefined);
  mockAcceptOnce.mockResolvedValue(true);
  mockPublishAdminStream.mockResolvedValue(undefined);
  mockUpsertReaction.mockResolvedValue(undefined);
  // Default: no pool (passthrough).
  mockGetOrgForSession.mockResolvedValue(null);
  // Default: session doc returns primary session.
  mockGetSession.mockResolvedValue(makeSession(PRIMARY_SESSION));
});

// ---------------------------------------------------------------------------
// 1. POOLED INBOUND NORMALIZATION
// ---------------------------------------------------------------------------

describe('org-dispatch, pooled inbound normalises to pool head', () => {
  beforeEach(() => {
    // Any session lookup resolves to the pool.
    mockGetOrgForSession.mockResolvedValue(ORG_DOC);
  });

  it('calls insertInbound with the pool-head sessionId, not the backup id', async () => {
    const res = await POST(makeInboundRequest(BACKUP_SESSION));
    expect(res.status).toBe(200);
    expect(mockInsertInbound).toHaveBeenCalledOnce();
    const doc = mockInsertInbound.mock.calls[0]![0] as { sessionId: string };
    expect(doc.sessionId).toBe(PRIMARY_SESSION);
  });

  it('dispatches inbound.received with event.sessionId set to the pool head', async () => {
    await POST(makeInboundRequest(BACKUP_SESSION));
    const inboundCall = mockDispatch.mock.calls.find(
      (c) => (c[0] as { type?: string })?.type === 'inbound.received',
    );
    expect(inboundCall).toBeDefined();
    const event = inboundCall![0] as { type: string; sessionId: string };
    expect(event.sessionId).toBe(PRIMARY_SESSION);
  });

  it('calls dispatchEventBackground with sessionIds: [pool-head], not the backup id', async () => {
    await POST(makeInboundRequest(BACKUP_SESSION));
    const inboundCall = mockDispatch.mock.calls.find(
      (c) => (c[0] as { type?: string })?.type === 'inbound.received',
    );
    expect(inboundCall).toBeDefined();
    const opts = inboundCall![1] as { sessionIds: string[] };
    expect(opts.sessionIds).toEqual([PRIMARY_SESSION]);
  });

  it('calls listKeysBySession with the pool-head sessionId', async () => {
    await POST(makeInboundRequest(BACKUP_SESSION));
    expect(mockListKeysBySession).toHaveBeenCalledWith(PRIMARY_SESSION);
  });
});

// ---------------------------------------------------------------------------
// 2. UNGROUPED PASSTHROUGH
// ---------------------------------------------------------------------------

describe('org-dispatch, non-pooled session passes through unchanged', () => {
  it('calls insertInbound with the raw sessionId when getOrgForSession returns null', async () => {
    // mockGetOrgForSession already returns null by default.
    const res = await POST(makeInboundRequest(SOLO_SESSION));
    expect(res.status).toBe(200);
    expect(mockInsertInbound).toHaveBeenCalledOnce();
    const doc = mockInsertInbound.mock.calls[0]![0] as { sessionId: string };
    expect(doc.sessionId).toBe(SOLO_SESSION);
  });

  it('dispatches inbound.received with event.sessionId equal to the raw id', async () => {
    await POST(makeInboundRequest(SOLO_SESSION));
    const inboundCall = mockDispatch.mock.calls.find(
      (c) => (c[0] as { type?: string })?.type === 'inbound.received',
    );
    expect(inboundCall).toBeDefined();
    const event = inboundCall![0] as { sessionId: string };
    expect(event.sessionId).toBe(SOLO_SESSION);
  });

  it('calls listKeysBySession with the raw sessionId', async () => {
    await POST(makeInboundRequest(SOLO_SESSION));
    expect(mockListKeysBySession).toHaveBeenCalledWith(SOLO_SESSION);
  });
});

// ---------------------------------------------------------------------------
// 3. OPT-OUT POOL-SCOPED HANDSHAKE
// ---------------------------------------------------------------------------

describe('org-dispatch, opt-out handshake is keyed on the orgId across devices', () => {
  beforeEach(() => {
    mockGetOrgForSession.mockResolvedValue(ORG_DOC);
    // Provide a session doc for keyword lookup (the route calls getSession(sessionId) inside
    // the opt-out block using the raw device sessionId, not the dispatched one).
    mockGetSession.mockResolvedValue(makeSession(PRIMARY_SESSION));
  });

  it('calls tryStartPendingOptOut with the orgId as the first argument on the first STOP', async () => {
    mockTryStart.mockResolvedValue(true); // window opens

    await POST(makeInboundRequest(PRIMARY_SESSION, 'STOP'));

    expect(mockTryStart).toHaveBeenCalledOnce();
    const [scope] = mockTryStart.mock.calls[0]!;
    expect(scope).toBe(ORG_ID);
  });

  it('calls tryStartPendingOptOut with the orgId even when the STOP arrives via the backup device', async () => {
    mockTryStart.mockResolvedValue(true);

    await POST(makeInboundRequest(BACKUP_SESSION, 'STOP'));

    expect(mockTryStart).toHaveBeenCalledOnce();
    const [scope] = mockTryStart.mock.calls[0]!;
    expect(scope).toBe(ORG_ID);
  });

  it('both STOP steps use the same poolId scope regardless of which device processed each', async () => {
    // First STOP opens the window.
    mockTryStart.mockResolvedValueOnce(true);
    await POST(makeInboundRequest(PRIMARY_SESSION, 'STOP'));

    // Second STOP (different device), window already open → confirmation.
    mockTryStart.mockResolvedValueOnce(false);
    await POST(makeInboundRequest(BACKUP_SESSION, 'STOP'));

    expect(mockTryStart).toHaveBeenCalledTimes(2);
    const scopes = mockTryStart.mock.calls.map((c) => c[0]);
    expect(scopes[0]).toBe(ORG_ID);
    expect(scopes[1]).toBe(ORG_ID);
  });

  it('commits the opt-out and clears pending with the orgId on the second STOP', async () => {
    // First STOP opens the window.
    mockTryStart.mockResolvedValueOnce(true);
    await POST(makeInboundRequest(PRIMARY_SESSION, 'STOP'));

    // Second STOP confirms.
    mockTryStart.mockResolvedValueOnce(false);
    await POST(makeInboundRequest(BACKUP_SESSION, 'STOP'));

    expect(mockAddOptOut).toHaveBeenCalledOnce();
    expect(mockClearPending).toHaveBeenCalledOnce();
    const [clearScope] = mockClearPending.mock.calls[0]!;
    expect(clearScope).toBe(ORG_ID);
  });

  it('uses isOptedOutAcrossOrg (not isOptedOut) when a pool is active', async () => {
    mockTryStart.mockResolvedValue(true);

    await POST(makeInboundRequest(PRIMARY_SESSION, 'STOP'));

    expect(mockIsOptedOutAcrossOrg).toHaveBeenCalledOnce();
    expect(mockIsOptedOut).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 4. REACTION CROSS-DEVICE DEDUP
// ---------------------------------------------------------------------------

describe('org-dispatch, reaction cross-device dedup via acceptOnce', () => {
  const WAMID = 'BAE5REACT0001';

  beforeEach(() => {
    mockGetOrgForSession.mockResolvedValue(ORG_DOC);
  });

  it('dispatches inbound.reaction exactly once when the second device loses the acceptOnce race', async () => {
    mockAcceptOnce
      .mockResolvedValueOnce(true) // first device wins
      .mockResolvedValueOnce(false); // second device loses

    await POST(makeReactionRequest(PRIMARY_SESSION, WAMID));
    await POST(makeReactionRequest(BACKUP_SESSION, WAMID));

    const reactionCalls = mockDispatch.mock.calls.filter(
      (c) => (c[0] as { type?: string })?.type === 'inbound.reaction',
    );
    expect(reactionCalls).toHaveLength(1);
  });

  it('dispatches the inbound.reaction event with the pool-head sessionId', async () => {
    mockAcceptOnce.mockResolvedValue(true);

    await POST(makeReactionRequest(BACKUP_SESSION, WAMID));

    const reactionCall = mockDispatch.mock.calls.find(
      (c) => (c[0] as { type?: string })?.type === 'inbound.reaction',
    );
    expect(reactionCall).toBeDefined();
    const event = reactionCall![0] as { sessionId: string };
    expect(event.sessionId).toBe(PRIMARY_SESSION);
  });

  it('still calls upsertReactionFromEvent on the second delivery even when acceptOnce returns false', async () => {
    mockAcceptOnce.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await POST(makeReactionRequest(PRIMARY_SESSION, WAMID));
    await POST(makeReactionRequest(BACKUP_SESSION, WAMID));

    // Persist runs on every delivery; only the webhook fan-out is gated.
    expect(mockUpsertReaction).toHaveBeenCalledTimes(2);
  });
});

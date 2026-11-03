/**
 * POST /v1/worker/callback, inbound happy path: fromE164 persistence.
 *
 * Verifies that the route derives `fromE164` from the raw Baileys JID and
 * passes it through to `insertInbound`, covering both individual JIDs
 * (which produce an E.164 string) and group JIDs (which must produce null).
 *
 * Mocked boundaries:
 *   - @/lib/worker-jwt, verifyWorkerJwt
 *   - @/lib/wire, verify, acceptNonce, isFreshTimestamp
 *   - @/lib/repositories/worker-state, upsertWorker
 *   - @/lib/repositories/sessions, upsertSession, updateSession, getSession, listSessionsByWorker
 *   - @/lib/repositories/optouts, addOptOut
 *   - @/lib/repositories/messages, updateStatus, findByMessageId, findByWaMessageId
 *   - @/lib/repositories/audit, appendAudit
 *   - @/lib/repositories/api-keys, listKeysBySession
 *   - @/lib/repositories/inbound-messages, insertInbound
 *   - @/lib/repositories/chat-events, insertChatEvent
 *   - @/lib/webhook-dispatch, dispatchEventBackground
 *   - @/lib/logger, logger
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- module mocks -----------------------------------------------------------

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

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ---- imports after mocks ----------------------------------------------------

import { POST } from '@/app/v1/worker/callback/route';
import { verifyWorkerJwt } from '@/lib/worker-jwt';
import { insertInbound } from '@/lib/repositories/inbound-messages';
import { publishAdminStream } from '@/lib/admin-stream';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockVerifyWorkerJwt = verifyWorkerJwt as ReturnType<typeof vi.fn>;
const mockInsertInbound = insertInbound as ReturnType<typeof vi.fn>;
const mockPublishAdminStream = publishAdminStream as ReturnType<typeof vi.fn>;

const SESSION_ID = 'test-session';
const WORKER_ID = 'worker-1';

function makeInboundRequest(from: string): Request {
  const body = {
    v: 1,
    kind: 'inbound',
    nonce: 'nonce-' + crypto.randomUUID(),
    at: new Date().toISOString(),
    sig: 'a'.repeat(64),
    workerId: WORKER_ID,
    sessionId: SESSION_ID,
    waMessageId: 'wa-inbound-test-001',
    from,
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

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();

  mockVerifyWorkerJwt.mockResolvedValue({
    workerId: WORKER_ID,
    typ: 'refresh',
    jti: 'jti-1',
  });
});

// ---------------------------------------------------------------------------
// Individual JID, fromE164 populated
// ---------------------------------------------------------------------------

describe('callback inbound, fromE164 on individual JID', () => {
  it('calls insertInbound with the E.164 form of the sender JID', async () => {
    const res = await POST(makeInboundRequest('447700900456@s.whatsapp.net'));
    expect(res.status).toBe(200);
    expect(mockInsertInbound).toHaveBeenCalledOnce();
    const doc = mockInsertInbound.mock.calls[0]![0] as { fromE164: string | null };
    expect(doc.fromE164).toBe('+447700900456');
  });
});

// ---------------------------------------------------------------------------
// Group JID, fromE164 null (defensive path)
// ---------------------------------------------------------------------------

describe('callback inbound, fromE164 null for group JID', () => {
  it('calls insertInbound with fromE164: null for a group sender', async () => {
    const res = await POST(makeInboundRequest('12345-67890@g.us'));
    expect(res.status).toBe(200);
    expect(mockInsertInbound).toHaveBeenCalledOnce();
    const doc = mockInsertInbound.mock.calls[0]![0] as { fromE164: string | null };
    expect(doc.fromE164).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Admin SSE publish, inbound DM triggers publishAdminStream
// ---------------------------------------------------------------------------

describe('callback inbound, publishAdminStream on DM inbound', () => {
  it('calls publishAdminStream once with the correct inbound envelope', async () => {
    await POST(makeInboundRequest('447700900456@s.whatsapp.net'));
    expect(mockPublishAdminStream).toHaveBeenCalledOnce();
    const payload = mockPublishAdminStream.mock.calls[0]![0] as {
      kind: string;
      sessionId: string;
      counterpartyE164: string;
      messageId: string;
    };
    expect(payload.kind).toBe('inbound');
    expect(payload.sessionId).toBe(SESSION_ID);
    expect(payload.counterpartyE164).toBe('+447700900456');
    expect(typeof payload.messageId).toBe('string');
    expect(payload.messageId.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Admin SSE publish, group inbound does NOT trigger publishAdminStream
// ---------------------------------------------------------------------------

describe('callback inbound, no publishAdminStream for group-JID inbound', () => {
  it('does not call publishAdminStream when fromE164 is null (group sender)', async () => {
    await POST(makeInboundRequest('12345-67890@g.us'));
    expect(mockPublishAdminStream).not.toHaveBeenCalled();
  });
});

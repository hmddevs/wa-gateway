/**
 * POST /v1/worker/callback, inbound keyword opt-out detection.
 *
 * Mocked boundaries:
 *   - @/lib/worker-jwt, verifyWorkerJwt
 *   - @/lib/wire, verify, acceptNonce, isFreshTimestamp
 *   - @/lib/repositories/worker-state, upsertWorker
 *   - @/lib/repositories/sessions, upsertSession, getSession, listSessionsByWorker
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

vi.mock('@/lib/repositories/worker-state', () => ({
  upsertWorker: vi.fn().mockResolvedValue(undefined),
  getWorker: vi.fn().mockResolvedValue(null),
  getCachedWorker: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/lib/repositories/sessions', () => ({
  upsertSession: vi.fn().mockResolvedValue(undefined),
  getSession: vi.fn(),
  getCachedSession: vi.fn(),
  listSessionsByWorker: vi.fn().mockResolvedValue([]),
}));

vi.mock('@/lib/repositories/optouts', () => ({
  addOptOut: vi.fn().mockResolvedValue(undefined),
  isOptedOut: vi.fn().mockResolvedValue(false),
}));

vi.mock('@/lib/repositories/optout-pending', () => ({
  tryStartPendingOptOut: vi.fn().mockResolvedValue(true),
  clearPendingOptOut: vi.fn().mockResolvedValue(undefined),
  OPTOUT_CONFIRM_TTL_SECONDS: 1800,
}));

vi.mock('@/lib/redis', () => ({
  getRedis: vi.fn(() => ({ publish: vi.fn().mockResolvedValue(1) })),
  subscribeOnce: vi.fn(),
}));

vi.mock('@/lib/wire', () => ({
  verify: vi.fn().mockResolvedValue(true),
  acceptNonce: vi.fn().mockResolvedValue(true),
  acceptInboundOnce: vi.fn().mockResolvedValue(true),
  acceptOnce: vi.fn().mockResolvedValue(true),
  isFreshTimestamp: vi.fn().mockReturnValue(true),
  sign: vi.fn(async (env_: Record<string, unknown>) => ({ ...env_, sig: 'signed' })),
  newNonce: vi.fn(() => 'nonce-x'),
  nowIso: vi.fn(() => new Date().toISOString()),
  lpushPending: vi.fn().mockResolvedValue(undefined),
  channels: { outbound: (id: string) => `wa:outbound:${id}` },
}));

vi.mock('@/lib/repositories/organizations', () => ({
  getOrgForSession: vi.fn().mockResolvedValue(null),
  isOptedOutAcrossOrg: vi.fn().mockResolvedValue(false),
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
import { acceptNonce, isFreshTimestamp, verify } from '@/lib/wire';
import { addOptOut, isOptedOut } from '@/lib/repositories/optouts';
import { tryStartPendingOptOut, clearPendingOptOut } from '@/lib/repositories/optout-pending';
import { lpushPending } from '@/lib/wire';
import { dispatchEventBackground } from '@/lib/webhook-dispatch';
import { getSession } from '@/lib/repositories/sessions';
import type { SessionDoc } from '@/lib/repositories/sessions';
import { publishAdminStream } from '@/lib/admin-stream';
import { insertInbound } from '@/lib/repositories/inbound-messages';
import { listKeysBySession } from '@/lib/repositories/api-keys';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockVerifyWorkerJwt = verifyWorkerJwt as ReturnType<typeof vi.fn>;
const mockAcceptNonce = acceptNonce as ReturnType<typeof vi.fn>;
const mockIsFreshTimestamp = isFreshTimestamp as ReturnType<typeof vi.fn>;
const mockVerify = verify as ReturnType<typeof vi.fn>;
const mockAddOptOut = addOptOut as ReturnType<typeof vi.fn>;
const mockIsOptedOut = isOptedOut as ReturnType<typeof vi.fn>;
const mockTryStart = tryStartPendingOptOut as ReturnType<typeof vi.fn>;
const mockClearPending = clearPendingOptOut as ReturnType<typeof vi.fn>;
const mockLpushPending = lpushPending as ReturnType<typeof vi.fn>;
const mockDispatch = dispatchEventBackground as ReturnType<typeof vi.fn>;
const mockGetSession = getSession as ReturnType<typeof vi.fn>;
const mockPublishAdminStream = publishAdminStream as ReturnType<typeof vi.fn>;
const mockInsertInbound = insertInbound as ReturnType<typeof vi.fn>;
const mockListKeysBySession = listKeysBySession as ReturnType<typeof vi.fn>;

const SESSION_ID = 'test-session';
const WORKER_ID = 'worker-1';

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

function makeInboundRequest(text: string): Request {
  const body = {
    v: 1,
    kind: 'inbound',
    nonce: 'nonce-' + crypto.randomUUID(),
    at: new Date().toISOString(),
    sig: 'a'.repeat(64),
    workerId: WORKER_ID,
    sessionId: SESSION_ID,
    waMessageId: 'wa-inbound-001',
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

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  // why: pin every mock that has a non-trivial default. Some Vitest CI configs
  // drop the factory mockResolvedValue implementations on clearAllMocks().
  // listKeysBySession in particular: when its `[]` default is dropped, the
  // route's `keys.map(...)` throws and aborts dispatch, explaining the
  // "dispatch spy called 0 times" failure on Linux runners.
  mockVerifyWorkerJwt.mockResolvedValue({
    workerId: WORKER_ID,
    typ: 'refresh',
    jti: 'jti-1',
  });
  mockVerify.mockResolvedValue(true);
  mockAcceptNonce.mockResolvedValue(true);
  mockIsFreshTimestamp.mockReturnValue(true);
  mockInsertInbound.mockResolvedValue(undefined);
  mockPublishAdminStream.mockResolvedValue(undefined);
  mockListKeysBySession.mockResolvedValue([]);
  mockAddOptOut.mockResolvedValue(undefined);
  mockIsOptedOut.mockResolvedValue(false);
  // Default: window opens (first keyword).
  mockTryStart.mockResolvedValue(true);
  mockClearPending.mockResolvedValue(undefined);
  mockLpushPending.mockResolvedValue(undefined);

  // Default: session exists with default keywords (STOP).
  mockGetSession.mockResolvedValue(makeSession());
});

// ---------------------------------------------------------------------------
// STOP, exact match triggers opt-out
// ---------------------------------------------------------------------------

describe('callback inbound, STOP keyword first step (handshake)', () => {
  it('records a pending request and prompts, but does NOT opt out yet', async () => {
    mockTryStart.mockResolvedValue(true);
    const res = await POST(makeInboundRequest('STOP'));
    expect(res.status).toBe(200);
    expect(mockTryStart).toHaveBeenCalledWith(SESSION_ID, '+447700900999', 'STOP');
    // Confirmation prompt enqueued for live + reconnect delivery.
    expect(mockLpushPending).toHaveBeenCalledTimes(1);
    // First step never commits an opt-out or emits the webhook.
    expect(mockAddOptOut).not.toHaveBeenCalled();
    const optOutCall = mockDispatch.mock.calls.find(
      (c) => (c[0] as { type?: string })?.type === 'contact.opted_out',
    );
    expect(optOutCall).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// STOP second step, confirmation commits the opt-out
// ---------------------------------------------------------------------------

describe('callback inbound, STOP keyword second step (confirmation)', () => {
  it('commits the opt-out, clears pending, and emits contact.opted_out', async () => {
    // Window already open → atomic start returns false → this is the confirmation.
    mockTryStart.mockResolvedValue(false);
    const res = await POST(makeInboundRequest('STOP'));
    expect(res.status).toBe(200);
    expect(mockAddOptOut).toHaveBeenCalledTimes(1);
    expect(mockAddOptOut).toHaveBeenCalledWith(SESSION_ID, '+447700900999', 'keyword', 'STOP');
    expect(mockClearPending).toHaveBeenCalledWith(SESSION_ID, '+447700900999');

    const optOutCall = mockDispatch.mock.calls.find(
      (c) => (c[0] as { type?: string })?.type === 'contact.opted_out',
    );
    expect(optOutCall).toBeDefined();
    const event = optOutCall![0] as {
      type: string;
      phone: string;
      source: string;
      keyword: string;
    };
    expect(event.phone).toBe('+447700900999');
    expect(event.source).toBe('keyword');
    expect(event.keyword).toBe('STOP');
    // Unsubscribe acknowledgement enqueued.
    expect(mockLpushPending).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// stop, case-insensitive (first step)
// ---------------------------------------------------------------------------

describe('callback inbound, stop keyword (lowercase)', () => {
  it('matches case-insensitively and records a pending request', async () => {
    await POST(makeInboundRequest('stop'));
    expect(mockTryStart).toHaveBeenCalledWith(SESSION_ID, '+447700900999', 'STOP');
    expect(mockAddOptOut).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// STOP with trailing space, trim (first step)
// ---------------------------------------------------------------------------

describe('callback inbound, STOP with trailing space', () => {
  it('trims whitespace and records a pending request', async () => {
    await POST(makeInboundRequest('STOP '));
    expect(mockTryStart).toHaveBeenCalledWith(SESSION_ID, '+447700900999', 'STOP');
    expect(mockAddOptOut).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Keyword buried in a sentence, exact-standalone regression guard
// ---------------------------------------------------------------------------

describe('callback inbound, keyword inside a sentence', () => {
  it('does nothing for "please stop the order" (not an exact match)', async () => {
    await POST(makeInboundRequest('please stop the order'));
    expect(mockTryStart).not.toHaveBeenCalled();
    expect(mockAddOptOut).not.toHaveBeenCalled();
    expect(mockLpushPending).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Non-keyword text, no opt-out
// ---------------------------------------------------------------------------

describe('callback inbound, non-keyword text', () => {
  it('does not create an opt-out record for a normal inbound message', async () => {
    await POST(makeInboundRequest('Hello, how are you?'));
    expect(mockAddOptOut).not.toHaveBeenCalled();
  });

  it('still dispatches an inbound.received event for a normal message', async () => {
    await POST(makeInboundRequest('Hello'));
    const calls = mockDispatch.mock.calls;
    const inboundCall = calls.find((c) => (c[0] as { type?: string })?.type === 'inbound.received');
    expect(inboundCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Already opted out, duplicate silently swallowed
// ---------------------------------------------------------------------------

describe('callback inbound, STOP when already opted out', () => {
  it('does not re-prompt or duplicate the opt-out for an already-opted-out contact', async () => {
    mockIsOptedOut.mockResolvedValue(true);
    const res = await POST(makeInboundRequest('STOP'));
    expect(res.status).toBe(200);
    // Already on the registry: no pending window opened, no addOptOut, no reply.
    expect(mockTryStart).not.toHaveBeenCalled();
    expect(mockAddOptOut).not.toHaveBeenCalled();
    expect(mockLpushPending).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Custom keyword UNSUBSCRIBE in session config
// ---------------------------------------------------------------------------

describe('callback inbound, custom keyword UNSUBSCRIBE', () => {
  it('triggers opt-out when the session configures UNSUBSCRIBE as a keyword', async () => {
    mockGetSession.mockResolvedValue(
      makeSession({
        conversation: { sendReadReceipts: true, optOutKeywords: ['UNSUBSCRIBE'] },
      } as unknown as Partial<SessionDoc>),
    );

    await POST(makeInboundRequest('UNSUBSCRIBE'));

    // First step: window keyed on the keyword the user actually sent.
    expect(mockTryStart).toHaveBeenCalledWith(SESSION_ID, '+447700900999', 'UNSUBSCRIBE');
    expect(mockAddOptOut).not.toHaveBeenCalled();
  });

  it('commits the opt-out for UNSUBSCRIBE on the confirmation step', async () => {
    mockGetSession.mockResolvedValue(
      makeSession({
        conversation: { sendReadReceipts: true, optOutKeywords: ['UNSUBSCRIBE'] },
      } as unknown as Partial<SessionDoc>),
    );
    mockTryStart.mockResolvedValue(false);

    await POST(makeInboundRequest('UNSUBSCRIBE'));

    expect(mockAddOptOut).toHaveBeenCalledWith(
      SESSION_ID,
      '+447700900999',
      'keyword',
      'UNSUBSCRIBE',
    );
  });

  it('does not trigger opt-out for STOP when only UNSUBSCRIBE is configured', async () => {
    mockGetSession.mockResolvedValue(
      makeSession({
        conversation: { sendReadReceipts: true, optOutKeywords: ['UNSUBSCRIBE'] },
      } as unknown as Partial<SessionDoc>),
    );

    await POST(makeInboundRequest('STOP'));

    expect(mockAddOptOut).not.toHaveBeenCalled();
    expect(mockTryStart).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Admin SSE publish fires for keyword-opt-out inbound
// ---------------------------------------------------------------------------

describe('callback inbound, publishAdminStream fires even when STOP keyword detected', () => {
  it('calls publishAdminStream for the inbound that triggers opt-out', async () => {
    // The inbound message is persisted and the SSE publish fires before
    // keyword detection, opt-out is orthogonal to live-stream fan-out.
    await POST(makeInboundRequest('STOP'));
    expect(mockPublishAdminStream).toHaveBeenCalled();
    const payload = mockPublishAdminStream.mock.calls[0]![0] as { kind: string };
    expect(payload.kind).toBe('inbound');
  });
});

/**
 * POST /v1/worker/callback, chat_event webhook-safety invariant.
 *
 * The chat_event case MUST persist to `chat_events` but MUST NOT fan out to
 * webhook subscribers, trigger opt-out keyword detection, or fire admin
 * notifications regardless of direction or source.
 *
 * Mocked boundaries: same set as keyword-optout.test.ts.
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
import { acceptNonce, isFreshTimestamp, verify } from '@/lib/wire';
import { insertChatEvent } from '@/lib/repositories/chat-events';
import { dispatchEventBackground } from '@/lib/webhook-dispatch';
import { addOptOut } from '@/lib/repositories/optouts';
import { insertInbound } from '@/lib/repositories/inbound-messages';
import { publishAdminStream } from '@/lib/admin-stream';
import { listKeysBySession } from '@/lib/repositories/api-keys';

// ---------------------------------------------------------------------------
// Typed mock references
// ---------------------------------------------------------------------------

const mockVerifyWorkerJwt = verifyWorkerJwt as ReturnType<typeof vi.fn>;
const mockAcceptNonce = acceptNonce as ReturnType<typeof vi.fn>;
const mockIsFreshTimestamp = isFreshTimestamp as ReturnType<typeof vi.fn>;
const mockVerify = verify as ReturnType<typeof vi.fn>;
const mockInsertChatEvent = insertChatEvent as ReturnType<typeof vi.fn>;
const mockDispatch = dispatchEventBackground as ReturnType<typeof vi.fn>;
const mockAddOptOut = addOptOut as ReturnType<typeof vi.fn>;
const mockInsertInbound = insertInbound as ReturnType<typeof vi.fn>;
const mockPublishAdminStream = publishAdminStream as ReturnType<typeof vi.fn>;
const mockListKeysBySession = listKeysBySession as ReturnType<typeof vi.fn>;

const SESSION_ID = 'test-session';
const WORKER_ID = 'worker-1';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeChatEventRequest(overrides: Record<string, unknown>): Request {
  const body = {
    v: 1,
    kind: 'chat_event',
    nonce: 'nonce-' + crypto.randomUUID(),
    at: new Date().toISOString(),
    sig: 'a'.repeat(64),
    workerId: WORKER_ID,
    sessionId: SESSION_ID,
    waMessageId: 'wa-chat-' + crypto.randomUUID(),
    counterpartyJid: '447700900000@s.whatsapp.net',
    counterpartyE164: '+447700900000',
    content: { kind: 'text', text: 'Hello from device' },
    ts: new Date().toISOString(),
    // Allow caller to override any field
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

function makeInboundRequest(): Request {
  const body = {
    v: 1,
    kind: 'inbound',
    nonce: 'nonce-' + crypto.randomUUID(),
    at: new Date().toISOString(),
    sig: 'a'.repeat(64),
    workerId: WORKER_ID,
    sessionId: SESSION_ID,
    waMessageId: 'wa-inbound-regression-001',
    from: '447700900999@s.whatsapp.net',
    body: { kind: 'text', text: 'Hello from contact' },
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
  // why: re-pin every mock with a non-trivial default. Some Vitest CI configs
  // drop the factory mockResolvedValue implementations on clearAllMocks().
  // verify and listKeysBySession in particular: their absence makes the route
  // either reject as bad signature (before chat_event/inbound branches) or
  // throw on `.map()` (mid-dispatch), explaining the "spy called 0 times"
  // failures observed only on Linux runners.
  mockVerifyWorkerJwt.mockResolvedValue({ workerId: WORKER_ID, typ: 'refresh', jti: 'jti-1' });
  mockVerify.mockResolvedValue(true);
  mockAcceptNonce.mockResolvedValue(true);
  mockIsFreshTimestamp.mockReturnValue(true);
  mockInsertChatEvent.mockResolvedValue({ duplicate: false });
  mockInsertInbound.mockResolvedValue(undefined);
  mockPublishAdminStream.mockResolvedValue(undefined);
  mockListKeysBySession.mockResolvedValue([]);
});

// ---------------------------------------------------------------------------
// Case A, out_device / live / DM
// ---------------------------------------------------------------------------

describe('callback chat_event, out_device live DM', () => {
  it('returns 2xx', async () => {
    const res = await POST(makeChatEventRequest({ direction: 'out_device', source: 'live' }));
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);
  });

  it('persists via insertChatEvent', async () => {
    await POST(makeChatEventRequest({ direction: 'out_device', source: 'live' }));
    expect(mockInsertChatEvent).toHaveBeenCalledOnce();
  });

  it('does not call dispatchEventBackground', async () => {
    await POST(makeChatEventRequest({ direction: 'out_device', source: 'live' }));
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('does not call addOptOut (no keyword detection)', async () => {
    await POST(makeChatEventRequest({ direction: 'out_device', source: 'live' }));
    expect(mockAddOptOut).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Case B, in / live / group (counterpartyE164 is null)
// ---------------------------------------------------------------------------

describe('callback chat_event, in live group message', () => {
  const GROUP_OVERRIDES = {
    direction: 'in',
    source: 'live',
    counterpartyJid: '12345@g.us',
    counterpartyE164: null,
  };

  it('returns 2xx', async () => {
    const res = await POST(makeChatEventRequest(GROUP_OVERRIDES));
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);
  });

  it('persists via insertChatEvent', async () => {
    await POST(makeChatEventRequest(GROUP_OVERRIDES));
    expect(mockInsertChatEvent).toHaveBeenCalledOnce();
  });

  it('does not call dispatchEventBackground', async () => {
    await POST(makeChatEventRequest(GROUP_OVERRIDES));
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('does not call addOptOut (no keyword detection)', async () => {
    await POST(makeChatEventRequest(GROUP_OVERRIDES));
    expect(mockAddOptOut).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Case C, in_history / history_sync (phase-3 not yet shipped, must be safe)
// ---------------------------------------------------------------------------

describe('callback chat_event, in_history history_sync', () => {
  const HISTORY_OVERRIDES = {
    direction: 'in_history',
    source: 'history_sync',
  };

  it('returns 2xx', async () => {
    const res = await POST(makeChatEventRequest(HISTORY_OVERRIDES));
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);
  });

  it('persists via insertChatEvent', async () => {
    await POST(makeChatEventRequest(HISTORY_OVERRIDES));
    expect(mockInsertChatEvent).toHaveBeenCalledOnce();
  });

  it('does not call dispatchEventBackground', async () => {
    await POST(makeChatEventRequest(HISTORY_OVERRIDES));
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('does not call addOptOut (no keyword detection)', async () => {
    await POST(makeChatEventRequest(HISTORY_OVERRIDES));
    expect(mockAddOptOut).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Admin SSE publish, live directions call publishAdminStream
// ---------------------------------------------------------------------------

describe('callback chat_event, publishAdminStream fires for out_device live', () => {
  it('calls publishAdminStream once with kind chat_event and direction out_device', async () => {
    await POST(makeChatEventRequest({ direction: 'out_device', source: 'live' }));
    expect(mockPublishAdminStream).toHaveBeenCalledOnce();
    const payload = mockPublishAdminStream.mock.calls[0]![0] as {
      kind: string;
      sessionId: string;
      direction: string;
    };
    expect(payload.kind).toBe('chat_event');
    expect(payload.sessionId).toBe(SESSION_ID);
    expect(payload.direction).toBe('out_device');
  });
});

describe('callback chat_event, publishAdminStream fires for in live group', () => {
  it('calls publishAdminStream once with kind chat_event and direction in', async () => {
    await POST(
      makeChatEventRequest({
        direction: 'in',
        source: 'live',
        counterpartyJid: '12345@g.us',
        counterpartyE164: null,
      }),
    );
    expect(mockPublishAdminStream).toHaveBeenCalledOnce();
    const payload = mockPublishAdminStream.mock.calls[0]![0] as {
      kind: string;
      direction: string;
    };
    expect(payload.kind).toBe('chat_event');
    expect(payload.direction).toBe('in');
  });
});

// ---------------------------------------------------------------------------
// Admin SSE publish, history-sync directions do NOT call publishAdminStream
// ---------------------------------------------------------------------------

describe('callback chat_event, publishAdminStream silent for in_history', () => {
  it('does not call publishAdminStream for direction in_history', async () => {
    await POST(makeChatEventRequest({ direction: 'in_history', source: 'history_sync' }));
    expect(mockPublishAdminStream).not.toHaveBeenCalled();
  });
});

describe('callback chat_event, publishAdminStream silent for out_history', () => {
  it('does not call publishAdminStream for direction out_history', async () => {
    await POST(makeChatEventRequest({ direction: 'out_history', source: 'history_sync' }));
    expect(mockPublishAdminStream).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Regression, existing inbound path still fans out to webhook
// ---------------------------------------------------------------------------

describe('callback inbound, regression: webhook dispatch still fires', () => {
  it('calls dispatchEventBackground for a normal inbound message', async () => {
    await POST(makeInboundRequest());
    expect(mockDispatch).toHaveBeenCalled();
  });

  it('calls insertInbound for a normal inbound message', async () => {
    await POST(makeInboundRequest());
    expect(mockInsertInbound).toHaveBeenCalled();
  });
});

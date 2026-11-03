/**
 * POST /v1/worker/callback, reaction persistence behaviour (slice 4b).
 *
 * The route's `kind: 'reaction'` branch now persists to `message_reactions`
 * via `upsertReactionFromEvent` before the existing webhook fan-out. The
 * tests cover:
 *   - first delivery → upsert called with the right shape
 *   - second delivery (same peer/message) → still one upsert call per
 *     delivery; replace-on-conflict semantic is enforced at the DB level by
 *     the unique index, so the route just calls upsert each time
 *   - cleared emoji (empty string) → still persisted (audit row stays)
 *   - persist failure does NOT break webhook fan-out
 *   - auth guard rejects without bearer token
 *
 * Mock surface mirrors revision-branch.test.ts.
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

// ---- imports after mocks ----------------------------------------------------

import { POST } from '@/app/v1/worker/callback/route';
import { verifyWorkerJwt } from '@/lib/worker-jwt';
import { acceptNonce, isFreshTimestamp, verify } from '@/lib/wire';
import { upsertReactionFromEvent } from '@/lib/repositories/message-reactions';
import { dispatchEventBackground } from '@/lib/webhook-dispatch';

// ---------------------------------------------------------------------------
// Typed mock references
// ---------------------------------------------------------------------------

const mockVerifyWorkerJwt = verifyWorkerJwt as ReturnType<typeof vi.fn>;
const mockAcceptNonce = acceptNonce as ReturnType<typeof vi.fn>;
const mockIsFreshTimestamp = isFreshTimestamp as ReturnType<typeof vi.fn>;
const mockVerify = verify as ReturnType<typeof vi.fn>;
const mockUpsertReactionFromEvent = upsertReactionFromEvent as ReturnType<typeof vi.fn>;
const mockDispatchEventBackground = dispatchEventBackground as ReturnType<typeof vi.fn>;

const SESSION_ID = 'test-session';
const WORKER_ID = 'worker-1';
const WAMID = 'BAE5ABCDEF0123456789';
const FROM_E164 = '+447700900000';
const FROM_JID = '447700900000@s.whatsapp.net';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReactionRequest(overrides: Record<string, unknown> = {}): Request {
  const body = {
    v: 1,
    kind: 'reaction',
    nonce: 'nonce-' + crypto.randomUUID(),
    at: new Date().toISOString(),
    sig: 'a'.repeat(64),
    workerId: WORKER_ID,
    sessionId: SESSION_ID,
    targetWaMessageId: WAMID,
    targetFromMe: true,
    from: FROM_E164,
    fromJid: FROM_JID,
    emoji: '👍',
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

beforeEach(() => {
  vi.clearAllMocks();
  // why: re-pin every mock, Vitest's clearAllMocks can reset factory defaults.
  mockVerifyWorkerJwt.mockResolvedValue({ workerId: WORKER_ID, typ: 'refresh', jti: 'jti-1' });
  mockVerify.mockResolvedValue(true);
  mockAcceptNonce.mockResolvedValue(true);
  mockIsFreshTimestamp.mockReturnValue(true);
  mockUpsertReactionFromEvent.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// First delivery, persist + fan-out
// ---------------------------------------------------------------------------

describe('reaction_persist, first delivery', () => {
  it('returns 200 and calls upsertReactionFromEvent with the right shape', async () => {
    const res = await POST(makeReactionRequest());
    expect(res.status).toBe(200);
    expect(mockUpsertReactionFromEvent).toHaveBeenCalledTimes(1);
    const [sessionIdArg, eventArg] = mockUpsertReactionFromEvent.mock.calls[0]!;
    expect(sessionIdArg).toBe(SESSION_ID);
    expect(eventArg).toMatchObject({
      targetWaMessageId: WAMID,
      targetFromMe: true,
      fromJid: FROM_JID,
      emoji: '👍',
    });
    expect(typeof (eventArg as { at: string }).at).toBe('string');
  });

  it('still fans out the inbound.reaction webhook after persisting', async () => {
    await POST(makeReactionRequest());
    expect(mockDispatchEventBackground).toHaveBeenCalledTimes(1);
    const [event] = mockDispatchEventBackground.mock.calls[0]!;
    expect((event as { type: string }).type).toBe('inbound.reaction');
  });
});

// ---------------------------------------------------------------------------
// Second delivery (same peer/message), replace-on-conflict semantic
// ---------------------------------------------------------------------------

describe('reaction_persist, replace-on-conflict', () => {
  // why: the unique index on (sessionId, waMessageId, fromJid) enforces
  // replace-on-conflict at the DB level (`replaceOne` upsert in the repo).
  // The route just calls upsert each time; this test pins that contract, a
  // second delivery for the same (peer, message) calls upsert again with the
  // updated emoji, NOT a separate insert path.
  it('two deliveries for the same (peer, message) result in two upsert calls', async () => {
    await POST(makeReactionRequest({ emoji: '👍' }));
    await POST(makeReactionRequest({ emoji: '❤️' }));
    expect(mockUpsertReactionFromEvent).toHaveBeenCalledTimes(2);
    const second = mockUpsertReactionFromEvent.mock.calls[1]![1] as { emoji: string };
    expect(second.emoji).toBe('❤️');
  });
});

// ---------------------------------------------------------------------------
// Cleared emoji, empty-string row preserved
// ---------------------------------------------------------------------------

describe('reaction_persist, cleared reaction', () => {
  it('persists an empty-string emoji (audit row preserved)', async () => {
    const res = await POST(makeReactionRequest({ emoji: '' }));
    expect(res.status).toBe(200);
    expect(mockUpsertReactionFromEvent).toHaveBeenCalledTimes(1);
    const [, event] = mockUpsertReactionFromEvent.mock.calls[0]!;
    expect((event as { emoji: string }).emoji).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Persist failure does NOT break webhook fan-out
// ---------------------------------------------------------------------------

describe('reaction_persist, persist failure is non-fatal', () => {
  it('still fans out the webhook when the repo throws', async () => {
    mockUpsertReactionFromEvent.mockRejectedValueOnce(new Error('mongo down'));
    const res = await POST(makeReactionRequest());
    expect(res.status).toBe(200);
    expect(mockDispatchEventBackground).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Auth guard
// ---------------------------------------------------------------------------

describe('reaction_persist, auth guard', () => {
  it('returns 401 when authorisation header is missing', async () => {
    const req = new Request('https://wa.test/v1/worker/callback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
    expect(mockUpsertReactionFromEvent).not.toHaveBeenCalled();
  });
});

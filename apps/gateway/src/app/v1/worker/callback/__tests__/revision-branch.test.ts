/**
 * POST /v1/worker/callback, message_revision branch behaviour.
 *
 * Covers the `kind: 'message_revision'` case added in slice 4. The route
 * dispatches to `insertRevisionFromEvent` after manual edit/delete
 * refinement (lines 588-613 of route.ts). Wire field is `revisionKind`
 * (not `kind`) to avoid the discriminator collision in `AnyEnvelope`.
 *
 * Mocked boundaries: same set as chat-event.test.ts, plus
 *   - @/lib/repositories/message-revisions, insertRevisionFromEvent
 *   - @/lib/repositories/contacts, upsertContactFromEvent
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
import { insertRevisionFromEvent } from '@/lib/repositories/message-revisions';

// ---------------------------------------------------------------------------
// Typed mock references
// ---------------------------------------------------------------------------

const mockVerifyWorkerJwt = verifyWorkerJwt as ReturnType<typeof vi.fn>;
const mockAcceptNonce = acceptNonce as ReturnType<typeof vi.fn>;
const mockIsFreshTimestamp = isFreshTimestamp as ReturnType<typeof vi.fn>;
const mockVerify = verify as ReturnType<typeof vi.fn>;
const mockInsertRevisionFromEvent = insertRevisionFromEvent as ReturnType<typeof vi.fn>;

const SESSION_ID = 'test-session';
const WORKER_ID = 'worker-1';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRevisionRequest(overrides: Record<string, unknown>): Request {
  const body = {
    v: 1,
    kind: 'message_revision',
    nonce: 'nonce-' + crypto.randomUUID(),
    at: new Date().toISOString(),
    sig: 'a'.repeat(64),
    workerId: WORKER_ID,
    sessionId: SESSION_ID,
    waMessageId: 'BAE5ABCDEF0123456789',
    source: 'live',
    ts: new Date().toISOString(),
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
  // why: re-pin every mock, Vitest's clearAllMocks can reset factory defaults
  // on some configurations. See chat-event.test.ts comments for rationale.
  mockVerifyWorkerJwt.mockResolvedValue({ workerId: WORKER_ID, typ: 'refresh', jti: 'jti-1' });
  mockVerify.mockResolvedValue(true);
  mockAcceptNonce.mockResolvedValue(true);
  mockIsFreshTimestamp.mockReturnValue(true);
  mockInsertRevisionFromEvent.mockResolvedValue({
    inserted: true,
    messageId: null,
    revisionSeq: 1,
  });
});

// ---------------------------------------------------------------------------
// Edit with waMessageId matching an existing message
// ---------------------------------------------------------------------------

describe('revision_branch, edit, messageId resolved', () => {
  it('returns 200 and calls insertRevisionFromEvent', async () => {
    mockInsertRevisionFromEvent.mockResolvedValueOnce({
      inserted: true,
      messageId: '00000000-0000-4000-8000-000000000001',
      revisionSeq: 1,
    });
    const res = await POST(
      makeRevisionRequest({
        revisionKind: 'edit',
        body: { kind: 'text', text: 'Edited body' },
      }),
    );
    expect(res.status).toBe(200);
    expect(mockInsertRevisionFromEvent).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Edit with waMessageId not matching any existing message (messageId null)
// ---------------------------------------------------------------------------

describe('revision_branch, edit, messageId null (original not yet persisted)', () => {
  it('returns 200 and calls insertRevisionFromEvent with null messageId path', async () => {
    // mock returns messageId: null, the repo will insert with waMessageId only
    mockInsertRevisionFromEvent.mockResolvedValueOnce({
      inserted: true,
      messageId: null,
      revisionSeq: 1,
    });
    const res = await POST(
      makeRevisionRequest({
        revisionKind: 'edit',
        body: { kind: 'text', text: 'Body before original arrived' },
      }),
    );
    expect(res.status).toBe(200);
    expect(mockInsertRevisionFromEvent).toHaveBeenCalledOnce();
    const [event] = mockInsertRevisionFromEvent.mock.calls[0] as [
      { kind: string; waMessageId: string },
    ];
    expect(event.kind).toBe('edit');
    expect(event.waMessageId).toBe('BAE5ABCDEF0123456789');
  });
});

// ---------------------------------------------------------------------------
// Delete with valid deletedBy
// ---------------------------------------------------------------------------

describe('revision_branch, delete, deletedBy: self', () => {
  it('returns 200 and passes kind delete to the repo', async () => {
    const res = await POST(
      makeRevisionRequest({
        revisionKind: 'delete',
        deletedBy: 'self',
      }),
    );
    expect(res.status).toBe(200);
    expect(mockInsertRevisionFromEvent).toHaveBeenCalledOnce();
    const [event] = mockInsertRevisionFromEvent.mock.calls[0] as [{ kind: string }];
    expect(event.kind).toBe('delete');
  });
});

// ---------------------------------------------------------------------------
// Validation: edit without body
// ---------------------------------------------------------------------------

describe('revision_branch, edit without body fails validation', () => {
  it('returns 400 when revisionKind is edit but body is absent', async () => {
    const res = await POST(
      makeRevisionRequest({
        revisionKind: 'edit',
        // body intentionally absent
      }),
    );
    expect(res.status).toBe(400);
    expect(mockInsertRevisionFromEvent).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Validation: delete with body present
// ---------------------------------------------------------------------------

describe('revision_branch, delete with body present fails validation', () => {
  it('returns 400 when revisionKind is delete but body is present', async () => {
    const res = await POST(
      makeRevisionRequest({
        revisionKind: 'delete',
        deletedBy: 'self',
        body: { kind: 'text', text: 'should not be here' },
      }),
    );
    expect(res.status).toBe(400);
    expect(mockInsertRevisionFromEvent).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Replay, two POSTs for the same waMessageId both succeed (no idempotency
// rejection at route level). revisionSeq is assigned by the repo; each call
// is independent. Route calls insertRevisionFromEvent twice.
// ---------------------------------------------------------------------------

describe('revision_branch, two edits for the same waMessageId are both forwarded', () => {
  it('calls insertRevisionFromEvent twice when the same edit is posted twice', async () => {
    // why: the route does not dedup revisions, the repo handles sequencing
    // via the 11000 unique-index retry. Two identical POSTs will hit the route
    // on different nonces (enforced by makeRevisionRequest's crypto.randomUUID)
    // and each results in a repo call. The repo would produce seq=1, seq=2.
    mockInsertRevisionFromEvent
      .mockResolvedValueOnce({ inserted: true, messageId: null, revisionSeq: 1 })
      .mockResolvedValueOnce({ inserted: true, messageId: null, revisionSeq: 2 });

    const payload = {
      revisionKind: 'edit',
      body: { kind: 'text', text: 'Same edit' },
    };
    const [r1, r2] = await Promise.all([
      POST(makeRevisionRequest(payload)),
      POST(makeRevisionRequest(payload)),
    ]);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(mockInsertRevisionFromEvent).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Two distinct edits for the same waMessageId, both routed to repo
// ---------------------------------------------------------------------------

describe('revision_branch, two distinct edits routed independently', () => {
  it('calls insertRevisionFromEvent for each edit with correct body', async () => {
    mockInsertRevisionFromEvent
      .mockResolvedValueOnce({ inserted: true, messageId: null, revisionSeq: 1 })
      .mockResolvedValueOnce({ inserted: true, messageId: null, revisionSeq: 2 });

    await POST(
      makeRevisionRequest({
        revisionKind: 'edit',
        body: { kind: 'text', text: 'First edit' },
      }),
    );
    await POST(
      makeRevisionRequest({
        revisionKind: 'edit',
        body: { kind: 'text', text: 'Second edit' },
      }),
    );

    expect(mockInsertRevisionFromEvent).toHaveBeenCalledTimes(2);
    const bodies = mockInsertRevisionFromEvent.mock.calls.map(
      (c) => (c[0] as { body: { text: string } }).body.text,
    );
    expect(bodies).toContain('First edit');
    expect(bodies).toContain('Second edit');
  });
});

// ---------------------------------------------------------------------------
// Auth, missing worker token
// ---------------------------------------------------------------------------

describe('revision_branch, auth: missing worker token', () => {
  it('returns 401 when Authorization header is absent', async () => {
    const body = {
      v: 1,
      kind: 'message_revision',
      nonce: 'nonce-' + crypto.randomUUID(),
      at: new Date().toISOString(),
      sig: 'a'.repeat(64),
      workerId: WORKER_ID,
      sessionId: SESSION_ID,
      waMessageId: 'BAE5ABCDEF0123456789',
      revisionKind: 'edit',
      body: { kind: 'text', text: 'Hello' },
      source: 'live',
      ts: new Date().toISOString(),
    };
    const req = new Request('https://wa.test/v1/worker/callback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
    expect(mockInsertRevisionFromEvent).not.toHaveBeenCalled();
  });

  it('returns 401 when the worker JWT is invalid', async () => {
    mockVerifyWorkerJwt.mockRejectedValueOnce(new Error('invalid token'));
    const res = await POST(
      makeRevisionRequest({
        revisionKind: 'edit',
        body: { kind: 'text', text: 'Hello' },
      }),
    );
    expect(res.status).toBe(401);
    expect(mockInsertRevisionFromEvent).not.toHaveBeenCalled();
  });
});

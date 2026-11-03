/**
 * POST /v1/worker/callback, `kind: 'group_metadata'` branch behaviour.
 *
 * Covers the group-metadata capture feature. The route dispatches to
 * `upsertGroup` (replace-on-conflict per
 * `(sessionId, jid)`). Wire shape is `GroupMetadataSchema` nested under
 * `metadata`.
 *
 * Mocked boundaries: same set as contact-branch.test.ts, plus
 *   - @/lib/repositories/groups, upsertGroup
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

vi.mock('@/lib/repositories/groups', () => ({
  upsertGroup: vi.fn().mockResolvedValue(undefined),
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
import { upsertGroup } from '@/lib/repositories/groups';

// ---------------------------------------------------------------------------
// Typed mock references
// ---------------------------------------------------------------------------

const mockVerifyWorkerJwt = verifyWorkerJwt as ReturnType<typeof vi.fn>;
const mockAcceptNonce = acceptNonce as ReturnType<typeof vi.fn>;
const mockIsFreshTimestamp = isFreshTimestamp as ReturnType<typeof vi.fn>;
const mockVerify = verify as ReturnType<typeof vi.fn>;
const mockUpsertGroup = upsertGroup as ReturnType<typeof vi.fn>;

const SESSION_ID = 'test-session';
const WORKER_ID = 'worker-1';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeGroupMetadataRequest(overrides: Record<string, unknown> = {}): Request {
  const body = {
    v: 1,
    kind: 'group_metadata',
    nonce: 'nonce-' + crypto.randomUUID(),
    at: new Date().toISOString(),
    sig: 'a'.repeat(64),
    workerId: WORKER_ID,
    sessionId: SESSION_ID,
    metadata: {
      jid: '120363000000000001@g.us',
      subject: 'HMD Ops',
      participants: [{ jid: '447700900001@s.whatsapp.net', admin: 'superadmin' }],
    },
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
  mockVerifyWorkerJwt.mockResolvedValue({ workerId: WORKER_ID, typ: 'refresh', jti: 'jti-1' });
  mockVerify.mockResolvedValue(true);
  mockAcceptNonce.mockResolvedValue(true);
  mockIsFreshTimestamp.mockReturnValue(true);
  mockUpsertGroup.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('group_metadata branch, happy path', () => {
  it('returns 200 and calls upsertGroup once', async () => {
    const res = await POST(makeGroupMetadataRequest());
    expect(res.status).toBe(200);
    expect(mockUpsertGroup).toHaveBeenCalledOnce();
  });

  it('passes sessionId, jid and metadata fields through to upsertGroup', async () => {
    await POST(makeGroupMetadataRequest());
    const [doc] = mockUpsertGroup.mock.calls[0] as [Record<string, unknown>];
    expect(doc.sessionId).toBe(SESSION_ID);
    expect(doc.jid).toBe('120363000000000001@g.us');
    expect(doc.subject).toBe('HMD Ops');
    expect(doc.participants).toEqual([{ jid: '447700900001@s.whatsapp.net', admin: 'superadmin' }]);
  });
});

// ---------------------------------------------------------------------------
// Replace on conflict, same (sessionId, jid) key
// ---------------------------------------------------------------------------

describe('group_metadata branch, upsert keyed on (sessionId, jid)', () => {
  it('calls upsertGroup for a re-push of the same jid, letting the repo replace rather than duplicate', async () => {
    await POST(
      makeGroupMetadataRequest({
        metadata: { jid: '120363000000000001@g.us', subject: 'HMD Ops' },
      }),
    );
    await POST(
      makeGroupMetadataRequest({
        metadata: { jid: '120363000000000001@g.us', subject: 'HMD Ops Renamed' },
      }),
    );

    expect(mockUpsertGroup).toHaveBeenCalledTimes(2);
    const jids = mockUpsertGroup.mock.calls.map((c) => (c[0] as { jid: string }).jid);
    expect(jids).toEqual(['120363000000000001@g.us', '120363000000000001@g.us']);
    const subjects = mockUpsertGroup.mock.calls.map((c) => (c[0] as { subject?: string }).subject);
    expect(subjects).toEqual(['HMD Ops', 'HMD Ops Renamed']);
  });
});

// ---------------------------------------------------------------------------
// Validation, malformed/partial metadata rejected, never persisted
// ---------------------------------------------------------------------------

describe('group_metadata branch, validation: missing required jid', () => {
  it('returns 400 and never calls upsertGroup when metadata.jid is absent', async () => {
    const res = await POST(makeGroupMetadataRequest({ metadata: { subject: 'No jid here' } }));
    expect(res.status).toBe(400);
    expect(mockUpsertGroup).not.toHaveBeenCalled();
  });
});

describe('group_metadata branch, validation: malformed subjectTime', () => {
  it('returns 400 when subjectTime is not an ISO datetime (e.g. raw unix seconds)', async () => {
    const res = await POST(
      makeGroupMetadataRequest({
        metadata: {
          jid: '120363000000000001@g.us',
          subjectTime: 1753000000, // raw unix seconds, not an ISO string, must be rejected
        },
      }),
    );
    expect(res.status).toBe(400);
    expect(mockUpsertGroup).not.toHaveBeenCalled();
  });
});

describe('group_metadata branch, validation: malformed participant entry', () => {
  it('returns 400 when a participant is missing jid', async () => {
    const res = await POST(
      makeGroupMetadataRequest({
        metadata: {
          jid: '120363000000000001@g.us',
          participants: [{ admin: 'admin' }],
        },
      }),
    );
    expect(res.status).toBe(400);
    expect(mockUpsertGroup).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Auth, missing worker token
// ---------------------------------------------------------------------------

describe('group_metadata branch, auth: missing worker token', () => {
  it('returns 401 when Authorization header is absent', async () => {
    const body = {
      v: 1,
      kind: 'group_metadata',
      nonce: 'nonce-' + crypto.randomUUID(),
      at: new Date().toISOString(),
      sig: 'a'.repeat(64),
      workerId: WORKER_ID,
      sessionId: SESSION_ID,
      metadata: { jid: '120363000000000001@g.us' },
    };
    const req = new Request('https://wa.test/v1/worker/callback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
    expect(mockUpsertGroup).not.toHaveBeenCalled();
  });
});

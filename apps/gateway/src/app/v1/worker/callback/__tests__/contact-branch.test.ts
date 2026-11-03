/**
 * POST /v1/worker/callback, contact branch behaviour.
 *
 * Covers the `kind: 'contact'` case added in slice 4. The route dispatches
 * to `upsertContactFromEvent` (replace-on-conflict). Wire shape carries
 * `e164`, `waJid`, `isBusiness`, optional `displayName`, `pushName`,
 * `profilePictureUrl`, `lastSeenAt`, `source`.
 *
 * Mocked boundaries: same set as chat-event.test.ts, plus
 *   - @/lib/repositories/contacts, upsertContactFromEvent
 *   - @/lib/repositories/message-revisions, insertRevisionFromEvent
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
import { upsertContactFromEvent } from '@/lib/repositories/contacts';

// ---------------------------------------------------------------------------
// Typed mock references
// ---------------------------------------------------------------------------

const mockVerifyWorkerJwt = verifyWorkerJwt as ReturnType<typeof vi.fn>;
const mockAcceptNonce = acceptNonce as ReturnType<typeof vi.fn>;
const mockIsFreshTimestamp = isFreshTimestamp as ReturnType<typeof vi.fn>;
const mockVerify = verify as ReturnType<typeof vi.fn>;
const mockUpsertContactFromEvent = upsertContactFromEvent as ReturnType<typeof vi.fn>;

const SESSION_ID = 'test-session';
const WORKER_ID = 'worker-1';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContactRequest(overrides: Record<string, unknown>): Request {
  const body = {
    v: 1,
    kind: 'contact',
    nonce: 'nonce-' + crypto.randomUUID(),
    at: new Date().toISOString(),
    sig: 'a'.repeat(64),
    workerId: WORKER_ID,
    sessionId: SESSION_ID,
    e164: '+447700900000',
    waJid: '447700900000@s.whatsapp.net',
    isBusiness: false,
    source: 'live',
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
  mockUpsertContactFromEvent.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// First insert of a new contact
// ---------------------------------------------------------------------------

describe('contact_branch, first insert', () => {
  it('returns 200 and calls upsertContactFromEvent', async () => {
    const res = await POST(makeContactRequest({ displayName: 'Alice' }));
    expect(res.status).toBe(200);
    expect(mockUpsertContactFromEvent).toHaveBeenCalledOnce();
  });

  it('passes all wire fields to upsertContactFromEvent', async () => {
    await POST(
      makeContactRequest({
        displayName: 'Alice',
        pushName: 'Alice A.',
        profilePictureUrl: 'https://cdn.example.com/avatar.jpg',
        isBusiness: true,
        source: 'history',
      }),
    );
    const [event] = mockUpsertContactFromEvent.mock.calls[0] as [Record<string, unknown>];
    expect(event.sessionId).toBe(SESSION_ID);
    expect(event.e164).toBe('+447700900000');
    expect(event.displayName).toBe('Alice');
    expect(event.isBusiness).toBe(true);
    expect(event.source).toBe('history');
  });
});

// ---------------------------------------------------------------------------
// Replace on conflict, same (sessionId, e164) with updated displayName
// ---------------------------------------------------------------------------

describe('contact_branch, replace on conflict', () => {
  it('calls upsertContactFromEvent for each POST (repo handles replace semantics)', async () => {
    await POST(makeContactRequest({ displayName: 'Alice' }));
    await POST(makeContactRequest({ displayName: 'Alice Smith' }));

    // Route always delegates to the repo; conflict resolution is repo-level.
    expect(mockUpsertContactFromEvent).toHaveBeenCalledTimes(2);
    const names = mockUpsertContactFromEvent.mock.calls.map(
      (c) => (c[0] as { displayName?: string }).displayName,
    );
    expect(names).toContain('Alice');
    expect(names).toContain('Alice Smith');
  });
});

// ---------------------------------------------------------------------------
// Validation, malformed e164
// ---------------------------------------------------------------------------

describe('contact_branch, validation: malformed e164', () => {
  it('returns 400 for a non-E.164 phone number', async () => {
    const res = await POST(makeContactRequest({ e164: '07700900000' }));
    expect(res.status).toBe(400);
    expect(mockUpsertContactFromEvent).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Validation, malformed profilePictureUrl
// ---------------------------------------------------------------------------

describe('contact_branch, validation: malformed profilePictureUrl', () => {
  it('returns 400 when profilePictureUrl is not a URL', async () => {
    const res = await POST(makeContactRequest({ profilePictureUrl: 'not-a-url' }));
    expect(res.status).toBe(400);
    expect(mockUpsertContactFromEvent).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Validation, missing required isBusiness
// ---------------------------------------------------------------------------

describe('contact_branch, validation: missing isBusiness', () => {
  it('returns 400 when isBusiness is absent', async () => {
    const body = {
      v: 1,
      kind: 'contact',
      nonce: 'nonce-' + crypto.randomUUID(),
      at: new Date().toISOString(),
      sig: 'a'.repeat(64),
      workerId: WORKER_ID,
      sessionId: SESSION_ID,
      e164: '+447700900000',
      waJid: '447700900000@s.whatsapp.net',
      // isBusiness intentionally absent
      source: 'live',
    };
    const req = new Request('https://wa.test/v1/worker/callback', {
      method: 'POST',
      headers: {
        authorization: 'Bearer worker-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(mockUpsertContactFromEvent).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Auth, missing worker token
// ---------------------------------------------------------------------------

describe('contact_branch, auth: missing worker token', () => {
  it('returns 401 when Authorization header is absent', async () => {
    const body = {
      v: 1,
      kind: 'contact',
      nonce: 'nonce-' + crypto.randomUUID(),
      at: new Date().toISOString(),
      sig: 'a'.repeat(64),
      workerId: WORKER_ID,
      sessionId: SESSION_ID,
      e164: '+447700900000',
      waJid: '447700900000@s.whatsapp.net',
      isBusiness: false,
      source: 'live',
    };
    const req = new Request('https://wa.test/v1/worker/callback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
    expect(mockUpsertContactFromEvent).not.toHaveBeenCalled();
  });
});

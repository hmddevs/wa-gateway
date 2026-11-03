/**
 * POST /v1/worker/callback/batch, `kind: 'group_metadata_batch'` branch.
 *
 * Covers the group-metadata capture feature. The route dispatches to
 * `upsertGroupBatch`, a single bulk write,
 * replace-on-conflict per `(sessionId, jid)`, same semantics as the
 * single-event `group_metadata` branch in `route.ts`.
 *
 * Mocked boundaries:
 *   - @/lib/worker-jwt, verifyWorkerJwt
 *   - @/lib/worker-auth, assertWorkerGenerationFresh
 *   - @/lib/wire, verify, acceptNonce, isFreshTimestamp
 *   - @/lib/repositories/chat-events, insertChatEventBatch
 *   - @/lib/repositories/chat-contacts, bulkUpsertChatContacts
 *   - @/lib/repositories/groups, upsertGroupBatch
 *   - @/lib/repositories/sessions, updateSession
 *   - @/lib/rate-limit, checkHistorySyncBatch
 *   - @/lib/logger, logger
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
  isFreshTimestamp: vi.fn().mockReturnValue(true),
}));

vi.mock('@/lib/repositories/chat-events', () => ({
  insertChatEventBatch: vi.fn(),
}));

vi.mock('@/lib/repositories/chat-contacts', () => ({
  bulkUpsertChatContacts: vi.fn(),
}));

vi.mock('@/lib/repositories/groups', () => ({
  upsertGroupBatch: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/repositories/sessions', () => ({
  updateSession: vi.fn().mockResolvedValue(null),
  invalidateSessionCache: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/webhook-dispatch', () => ({
  dispatchEvent: vi.fn(),
  dispatchEventBackground: vi.fn(),
}));

vi.mock('@/lib/rate-limit', () => ({
  checkHistorySyncBatch: vi.fn().mockResolvedValue(true),
  checkGlobal: vi.fn().mockResolvedValue(true),
  checkIp: vi.fn().mockResolvedValue(true),
  checkApiKey: vi.fn().mockResolvedValue(true),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ---- imports after mocks ----------------------------------------------------

import { POST } from '@/app/v1/worker/callback/batch/route';
import { verifyWorkerJwt } from '@/lib/worker-jwt';
import { upsertGroupBatch } from '@/lib/repositories/groups';

// ---------------------------------------------------------------------------
// Typed mock references
// ---------------------------------------------------------------------------

const mockVerifyWorkerJwt = verifyWorkerJwt as ReturnType<typeof vi.fn>;
const mockUpsertGroupBatch = upsertGroupBatch as ReturnType<typeof vi.fn>;

const SESSION_ID = 'test-session';
const WORKER_ID = 'worker-1';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBatchRequest(body: unknown): Request {
  return new Request('https://wa.test/v1/worker/callback/batch', {
    method: 'POST',
    headers: {
      authorization: 'Bearer worker-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

function makeEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    nonce: 'nonce-' + Math.random().toString(36).slice(2).padEnd(16, '0'),
    at: new Date().toISOString(),
    sig: 'a'.repeat(64),
    workerId: WORKER_ID,
    sessionId: SESSION_ID,
    ...overrides,
  };
}

function makeGroupItem(overrides: Record<string, unknown> = {}) {
  return {
    metadata: {
      jid: '120363000000000001@g.us',
      subject: 'HMD Ops',
      participants: [{ jid: '447700900001@s.whatsapp.net', admin: 'superadmin' }],
      ...overrides,
    },
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockVerifyWorkerJwt.mockResolvedValue({ workerId: WORKER_ID, typ: 'refresh', jti: 'jti-1' });
  mockUpsertGroupBatch.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('group_metadata_batch, happy path', () => {
  it('returns 2xx and calls upsertGroupBatch once with all items', async () => {
    const items = [
      makeGroupItem({ jid: '120363000000000001@g.us' }),
      makeGroupItem({ jid: '120363000000000002@g.us', subject: 'HMD Sales' }),
    ];
    const res = await POST(
      makeBatchRequest({ ...makeEnvelope({ kind: 'group_metadata_batch' }), items }),
    );

    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);
    expect(mockUpsertGroupBatch).toHaveBeenCalledOnce();
    const [docs] = mockUpsertGroupBatch.mock.calls[0] as [Array<Record<string, unknown>>];
    expect(docs).toHaveLength(2);
    expect(docs.every((d) => d.sessionId === SESSION_ID)).toBe(true);
    expect(docs.map((d) => d.jid)).toEqual(['120363000000000001@g.us', '120363000000000002@g.us']);
  });

  it('does not call dispatchEvent or dispatchEventBackground (reference data only)', async () => {
    const { dispatchEvent, dispatchEventBackground } = await import('@/lib/webhook-dispatch');
    await POST(
      makeBatchRequest({
        ...makeEnvelope({ kind: 'group_metadata_batch' }),
        items: [makeGroupItem()],
      }),
    );
    expect(dispatchEvent).not.toHaveBeenCalled();
    expect(dispatchEventBackground).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Upsert keyed on (sessionId, jid), re-push replaces rather than duplicates
// ---------------------------------------------------------------------------

describe('group_metadata_batch, upsert keyed on (sessionId, jid)', () => {
  it('re-pushing the same jid across two batches calls upsertGroupBatch twice, letting the repo replace', async () => {
    await POST(
      makeBatchRequest({
        ...makeEnvelope({ kind: 'group_metadata_batch' }),
        items: [makeGroupItem({ jid: '120363000000000001@g.us', subject: 'HMD Ops' })],
      }),
    );
    await POST(
      makeBatchRequest({
        ...makeEnvelope({ kind: 'group_metadata_batch' }),
        items: [makeGroupItem({ jid: '120363000000000001@g.us', subject: 'HMD Ops Renamed' })],
      }),
    );

    expect(mockUpsertGroupBatch).toHaveBeenCalledTimes(2);
    const subjects = mockUpsertGroupBatch.mock.calls.map(
      (c) => (c[0] as Array<{ subject?: string }>)[0]!.subject,
    );
    expect(subjects).toEqual(['HMD Ops', 'HMD Ops Renamed']);
  });
});

// ---------------------------------------------------------------------------
// Validation, malformed/partial item rejected before persistence
// ---------------------------------------------------------------------------

describe('group_metadata_batch, validation: missing required jid', () => {
  it('returns 4xx and never calls upsertGroupBatch when an item is missing metadata.jid', async () => {
    const res = await POST(
      makeBatchRequest({
        ...makeEnvelope({ kind: 'group_metadata_batch' }),
        items: [{ metadata: { subject: 'No jid here' } }],
      }),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(mockUpsertGroupBatch).not.toHaveBeenCalled();
  });
});

describe('group_metadata_batch, validation: malformed creation timestamp', () => {
  it('returns 4xx when creation is raw unix seconds rather than an ISO datetime', async () => {
    const res = await POST(
      makeBatchRequest({
        ...makeEnvelope({ kind: 'group_metadata_batch' }),
        items: [makeGroupItem({ jid: '120363000000000001@g.us', creation: 1753000000 })],
      }),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(mockUpsertGroupBatch).not.toHaveBeenCalled();
  });
});

describe('group_metadata_batch, validation: batch size cap', () => {
  it('returns 4xx for a 1001-item batch', async () => {
    const items = Array.from({ length: 1001 }, (_, i) =>
      makeGroupItem({ jid: `120363000000000${i.toString().padStart(3, '0')}@g.us` }),
    );
    const res = await POST(
      makeBatchRequest({ ...makeEnvelope({ kind: 'group_metadata_batch' }), items }),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(mockUpsertGroupBatch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Auth, unauthenticated request
// ---------------------------------------------------------------------------

describe('group_metadata_batch, auth: missing worker token', () => {
  it('returns 401 when Authorization header is absent', async () => {
    const req = new Request('https://wa.test/v1/worker/callback/batch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...makeEnvelope({ kind: 'group_metadata_batch' }),
        items: [makeGroupItem()],
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
    expect(mockUpsertGroupBatch).not.toHaveBeenCalled();
  });
});

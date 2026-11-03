/**
 * POST /v1/worker/callback/batch, batch ingress tests.
 *
 * Webhook-safety invariant: neither `chat_event_batch` nor `contact_batch`
 * must ever call dispatchEvent or dispatchEventBackground. Storage only.
 *
 * Mocked boundaries:
 *   - @/lib/worker-jwt, verifyWorkerJwt
 *   - @/lib/wire, verify, acceptNonce, isFreshTimestamp
 *   - @/lib/repositories/chat-events, insertChatEventBatch
 *   - @/lib/repositories/chat-contacts, bulkUpsertChatContacts
 *   - @/lib/repositories/sessions, updateSession
 *   - @/lib/webhook-dispatch, dispatchEvent, dispatchEventBackground
 *   - @/lib/logger, logger
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- module mocks -----------------------------------------------------------

vi.mock('@/lib/worker-jwt', () => ({
  verifyWorkerJwt: vi.fn(),
}));

// The route now runs a token-generation check; mock it to a no-op so this suite
// (which does not exercise revocation) doesn't pull in worker-state → redis → env.
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
  // why: stubs for the rest of the module's exports so transitive imports
  // (currently none in the batch route) don't NPE if extended later.
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
import { insertChatEventBatch } from '@/lib/repositories/chat-events';
import { bulkUpsertChatContacts } from '@/lib/repositories/chat-contacts';
import { updateSession } from '@/lib/repositories/sessions';
import { dispatchEvent, dispatchEventBackground } from '@/lib/webhook-dispatch';

// ---------------------------------------------------------------------------
// Typed mock references
// ---------------------------------------------------------------------------

const mockVerifyWorkerJwt = verifyWorkerJwt as ReturnType<typeof vi.fn>;
const mockInsertChatEventBatch = insertChatEventBatch as ReturnType<typeof vi.fn>;
const mockBulkUpsertChatContacts = bulkUpsertChatContacts as ReturnType<typeof vi.fn>;
const mockUpdateSession = updateSession as ReturnType<typeof vi.fn>;
const mockDispatchEvent = dispatchEvent as ReturnType<typeof vi.fn>;
const mockDispatchBackground = dispatchEventBackground as ReturnType<typeof vi.fn>;

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

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    waMessageId: 'wa-hist-' + Math.random().toString(36).slice(2),
    direction: 'in_history',
    source: 'history_sync',
    counterpartyJid: '447700900000@s.whatsapp.net',
    counterpartyE164: '+447700900000',
    content: { kind: 'text', text: 'History message' },
    ts: new Date().toISOString(),
    ...overrides,
  };
}

function makeContact(overrides: Record<string, unknown> = {}) {
  return {
    jid: '447700900001@s.whatsapp.net',
    e164: '+447700900001',
    pushName: 'Alice',
    notify: null,
    verifiedName: null,
    profilePicUrl: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockVerifyWorkerJwt.mockResolvedValue({ workerId: WORKER_ID, typ: 'refresh', jti: 'jti-1' });
  mockInsertChatEventBatch.mockResolvedValue({ inserted: 3, duplicates: 0 });
  mockBulkUpsertChatContacts.mockResolvedValue({ upserted: 3, modified: 0 });
  mockUpdateSession.mockResolvedValue(null);
});

// ---------------------------------------------------------------------------
// B1, chat_event_batch happy path
// ---------------------------------------------------------------------------

describe('batch route, chat_event_batch happy path (isLatest: false)', () => {
  const MIXED_EVENTS = [
    makeEvent({ direction: 'out_device', source: 'live', waMessageId: 'wa-out-dev-001' }),
    makeEvent({ direction: 'out_history', source: 'history_sync', waMessageId: 'wa-out-hist-001' }),
    makeEvent({ direction: 'in_history', source: 'history_sync', waMessageId: 'wa-in-hist-001' }),
  ];

  it('returns 2xx', async () => {
    const res = await POST(
      makeBatchRequest({
        ...makeEnvelope({ kind: 'chat_event_batch', isLatest: false }),
        events: MIXED_EVENTS,
      }),
    );
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);
  });

  it('calls insertChatEventBatch once with all three docs, each having ts as Date and ingestedAt set', async () => {
    await POST(
      makeBatchRequest({
        ...makeEnvelope({ kind: 'chat_event_batch', isLatest: false }),
        events: MIXED_EVENTS,
      }),
    );
    expect(mockInsertChatEventBatch).toHaveBeenCalledOnce();
    const [docs] = mockInsertChatEventBatch.mock.calls[0] as [
      Array<{
        ts: unknown;
        ingestedAt: unknown;
        direction: string;
      }>,
    ];
    expect(docs).toHaveLength(3);
    for (const doc of docs) {
      expect(doc.ts).toBeInstanceOf(Date);
      expect(doc.ingestedAt).toBeInstanceOf(Date);
    }
    const directions = docs.map((d) => d.direction);
    expect(directions).toContain('out_device');
    expect(directions).toContain('out_history');
    expect(directions).toContain('in_history');
  });

  it('does not call dispatchEvent or dispatchEventBackground', async () => {
    await POST(
      makeBatchRequest({
        ...makeEnvelope({ kind: 'chat_event_batch', isLatest: false }),
        events: MIXED_EVENTS,
      }),
    );
    expect(mockDispatchEvent).not.toHaveBeenCalled();
    expect(mockDispatchBackground).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// B2, chat_event_batch with isLatest: true
// ---------------------------------------------------------------------------

describe('batch route, chat_event_batch isLatest: true', () => {
  it('returns 2xx when isLatest is true', async () => {
    const res = await POST(
      makeBatchRequest({
        ...makeEnvelope({ kind: 'chat_event_batch', isLatest: true }),
        events: [makeEvent()],
      }),
    );
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);
  });

  it('does not call dispatchEvent or dispatchEventBackground when isLatest is true', async () => {
    await POST(
      makeBatchRequest({
        ...makeEnvelope({ kind: 'chat_event_batch', isLatest: true }),
        events: [makeEvent()],
      }),
    );
    expect(mockDispatchEvent).not.toHaveBeenCalled();
    expect(mockDispatchBackground).not.toHaveBeenCalled();
  });

  it('calls updateSession with historySyncProgress null to clear the badge immediately', async () => {
    await POST(
      makeBatchRequest({
        ...makeEnvelope({ kind: 'chat_event_batch', isLatest: true }),
        events: [makeEvent()],
      }),
    );
    // Fire-and-forget, flush the microtask queue so the promise settles.
    await Promise.resolve();
    expect(mockUpdateSession).toHaveBeenCalledWith(SESSION_ID, { historySyncProgress: null });
  });

  it('does not call updateSession when isLatest is false', async () => {
    await POST(
      makeBatchRequest({
        ...makeEnvelope({ kind: 'chat_event_batch', isLatest: false }),
        events: [makeEvent()],
      }),
    );
    await Promise.resolve();
    expect(mockUpdateSession).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// B3, chat_event_batch idempotency (duplicates reported)
// ---------------------------------------------------------------------------

describe('batch route, chat_event_batch idempotency', () => {
  it('returns 2xx and surfaces the duplicate count when some events are duplicates', async () => {
    mockInsertChatEventBatch.mockResolvedValueOnce({ inserted: 480, duplicates: 20 });
    const events = Array.from({ length: 500 }, (_, i) =>
      makeEvent({ waMessageId: `wa-idem-${i.toString().padStart(3, '0')}` }),
    );
    const res = await POST(
      makeBatchRequest({
        ...makeEnvelope({ kind: 'chat_event_batch', isLatest: false }),
        events,
      }),
    );
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);

    const json = (await res.json()) as { inserted: number; duplicates: number };
    expect(json.inserted).toBe(480);
    expect(json.duplicates).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// B4, contact_batch happy path
// ---------------------------------------------------------------------------

describe('batch route, contact_batch happy path', () => {
  const CONTACTS = [
    makeContact({ jid: '447700900001@s.whatsapp.net', e164: '+447700900001' }),
    makeContact({ jid: '447700900002@s.whatsapp.net', e164: '+447700900002', pushName: 'Bob' }),
    makeContact({ jid: '12345@g.us', e164: null }),
  ];

  it('returns 2xx', async () => {
    const res = await POST(
      makeBatchRequest({
        ...makeEnvelope({ kind: 'contact_batch' }),
        contacts: CONTACTS,
      }),
    );
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);
  });

  it('calls bulkUpsertChatContacts once with all three contacts', async () => {
    await POST(
      makeBatchRequest({
        ...makeEnvelope({ kind: 'contact_batch' }),
        contacts: CONTACTS,
      }),
    );
    expect(mockBulkUpsertChatContacts).toHaveBeenCalledOnce();
    const [sessionId, contacts] = mockBulkUpsertChatContacts.mock.calls[0] as [
      string,
      Array<{ jid: string }>,
    ];
    expect(sessionId).toBe(SESSION_ID);
    expect(contacts).toHaveLength(3);
  });

  it('does not call dispatchEvent or dispatchEventBackground', async () => {
    await POST(
      makeBatchRequest({
        ...makeEnvelope({ kind: 'contact_batch' }),
        contacts: CONTACTS,
      }),
    );
    expect(mockDispatchEvent).not.toHaveBeenCalled();
    expect(mockDispatchBackground).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// B5, batch size cap: 501 events rejected before persistence
// ---------------------------------------------------------------------------

describe('batch route, 501-event batch rejected', () => {
  it('returns 4xx for a 501-event batch', async () => {
    const events = Array.from({ length: 501 }, (_, i) =>
      makeEvent({ waMessageId: `wa-cap-${i.toString().padStart(3, '0')}` }),
    );
    const res = await POST(
      makeBatchRequest({
        ...makeEnvelope({ kind: 'chat_event_batch', isLatest: false }),
        events,
      }),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it('does not call insertChatEventBatch when batch exceeds cap', async () => {
    const events = Array.from({ length: 501 }, (_, i) =>
      makeEvent({ waMessageId: `wa-cap-${i.toString().padStart(3, '0')}` }),
    );
    await POST(
      makeBatchRequest({
        ...makeEnvelope({ kind: 'chat_event_batch', isLatest: false }),
        events,
      }),
    );
    expect(mockInsertChatEventBatch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// B6, malformed payload
// ---------------------------------------------------------------------------

describe('batch route, malformed payload: missing type', () => {
  it('returns 4xx when the type/kind field is absent', async () => {
    const res = await POST(
      makeBatchRequest({
        ...makeEnvelope(),
        events: [makeEvent()],
      }),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it('does not call insertChatEventBatch when kind is missing', async () => {
    await POST(
      makeBatchRequest({
        ...makeEnvelope(),
        events: [makeEvent()],
      }),
    );
    expect(mockInsertChatEventBatch).not.toHaveBeenCalled();
  });
});

describe('batch route, malformed payload: wrong kind value', () => {
  it('returns 4xx for an unrecognised kind', async () => {
    const res = await POST(
      makeBatchRequest({
        ...makeEnvelope({ kind: 'unknown_batch' }),
        events: [makeEvent()],
      }),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});

describe('batch route, malformed payload: missing required event field', () => {
  it('returns 4xx when an event is missing waMessageId', async () => {
    const { waMessageId: _omit, ...eventWithoutId } = makeEvent();
    const res = await POST(
      makeBatchRequest({
        ...makeEnvelope({ kind: 'chat_event_batch', isLatest: false }),
        events: [eventWithoutId],
      }),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(mockInsertChatEventBatch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// B7, unauthenticated request
// ---------------------------------------------------------------------------

describe('batch route, unauthenticated request', () => {
  it('returns 401 when Authorization header is absent', async () => {
    const res = await fetch('https://wa.test/v1/worker/callback/batch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...makeEnvelope({ kind: 'chat_event_batch', isLatest: false }),
        events: [makeEvent()],
      }),
    }).catch(() => null);

    // Fetch to an un-served URL will fail at the network layer; instead,
    // construct the Request directly and call POST without an auth header.
    const req = new Request('https://wa.test/v1/worker/callback/batch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...makeEnvelope({ kind: 'chat_event_batch', isLatest: false }),
        events: [makeEvent()],
      }),
    });
    const response = await POST(req);
    expect(response.status).toBe(401);
    expect(mockInsertChatEventBatch).not.toHaveBeenCalled();
  });

  it('returns 401 when the worker JWT is invalid', async () => {
    mockVerifyWorkerJwt.mockRejectedValueOnce(new Error('invalid token'));
    const res = await POST(
      makeBatchRequest({
        ...makeEnvelope({ kind: 'chat_event_batch', isLatest: false }),
        events: [makeEvent()],
      }),
    );
    expect(res.status).toBe(401);
    expect(mockInsertChatEventBatch).not.toHaveBeenCalled();
  });
});

/**
 * POST /v1/worker/callback/batch, history-sync envelope marker and relaxed
 * rate-limit behaviour.
 *
 * Covers the `historySync` envelope field added in slice 1 and consumed by
 * the batch route in slice 4. When present, the route calls
 * `checkHistorySyncBatch(sessionId, eventCount)` before persisting. When
 * absent, the route skips all rate-limit checks (the batch path has no
 * normal-mode limiter, live batches are throttled globally on the worker
 * side, not here).
 *
 * Mocked boundaries: same set as batch.route.test.ts, plus
 *   - @/lib/rate-limit, checkHistorySyncBatch
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
import { insertChatEventBatch } from '@/lib/repositories/chat-events';
import { checkHistorySyncBatch } from '@/lib/rate-limit';

// ---------------------------------------------------------------------------
// Typed mock references
// ---------------------------------------------------------------------------

const mockVerifyWorkerJwt = verifyWorkerJwt as ReturnType<typeof vi.fn>;
const mockInsertChatEventBatch = insertChatEventBatch as ReturnType<typeof vi.fn>;
const mockCheckHistorySyncBatch = checkHistorySyncBatch as ReturnType<typeof vi.fn>;

const SESSION_ID = 'session-a';
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

function makeEvents(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    waMessageId: `wa-hist-${i.toString().padStart(4, '0')}`,
    direction: 'in_history',
    source: 'history_sync',
    counterpartyJid: '447700900000@s.whatsapp.net',
    counterpartyE164: '+447700900000',
    content: { kind: 'text', text: `Message ${i}` },
    ts: new Date().toISOString(),
  }));
}

function makeHistorySyncHeader(sessionId = SESSION_ID, batchIndex = 0) {
  return {
    historySync: true,
    sessionId,
    batchIndex,
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  // why: re-pin every mock, Vitest's clearAllMocks can reset factory defaults.
  mockVerifyWorkerJwt.mockResolvedValue({ workerId: WORKER_ID, typ: 'refresh', jti: 'jti-1' });
  mockInsertChatEventBatch.mockResolvedValue({ inserted: 10, duplicates: 0 });
  mockCheckHistorySyncBatch.mockResolvedValue(true);
});

// ---------------------------------------------------------------------------
// historySync header present, rate-limit bucket charged
// ---------------------------------------------------------------------------

describe('history_sync_rate_limit, header present: history bucket charged', () => {
  it('calls checkHistorySyncBatch with sessionId and event count', async () => {
    const events = makeEvents(10);
    await POST(
      makeBatchRequest({
        ...makeEnvelope({
          kind: 'chat_event_batch',
          isLatest: false,
          historySync: makeHistorySyncHeader(),
        }),
        events,
      }),
    );
    expect(mockCheckHistorySyncBatch).toHaveBeenCalledOnce();
    const [calledSessionId, calledCount] = mockCheckHistorySyncBatch.mock.calls[0] as [
      string,
      number,
    ];
    expect(calledSessionId).toBe(SESSION_ID);
    expect(calledCount).toBe(10);
  });

  it('returns 200 when the rate-limit bucket allows the batch', async () => {
    const res = await POST(
      makeBatchRequest({
        ...makeEnvelope({
          kind: 'chat_event_batch',
          isLatest: false,
          historySync: makeHistorySyncHeader(),
        }),
        events: makeEvents(5),
      }),
    );
    expect(res.status).toBe(200);
    expect(mockInsertChatEventBatch).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// History bucket exhausted, 429 returned
// ---------------------------------------------------------------------------

describe('history_sync_rate_limit, cap exceeded returns 429', () => {
  it('returns 429 when checkHistorySyncBatch returns false', async () => {
    mockCheckHistorySyncBatch.mockResolvedValueOnce(false);
    const res = await POST(
      makeBatchRequest({
        ...makeEnvelope({
          kind: 'chat_event_batch',
          isLatest: false,
          historySync: makeHistorySyncHeader(),
        }),
        events: makeEvents(500),
      }),
    );
    expect(res.status).toBe(429);
    expect(mockInsertChatEventBatch).not.toHaveBeenCalled();
  });

  it('returns error body identifying the rate-limit cause', async () => {
    mockCheckHistorySyncBatch.mockResolvedValueOnce(false);
    const res = await POST(
      makeBatchRequest({
        ...makeEnvelope({
          kind: 'chat_event_batch',
          isLatest: false,
          historySync: makeHistorySyncHeader(),
        }),
        events: makeEvents(1),
      }),
    );
    expect(res.status).toBe(429);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// historySync header absent, rate-limit NOT called
// ---------------------------------------------------------------------------

describe('history_sync_rate_limit, no historySync header: rate limit not called', () => {
  it('does not call checkHistorySyncBatch for a live batch without historySync', async () => {
    // why: the batch route has no normal-mode rate limiter. Live batches
    // (worker `out_device` echoes) are throttled on the worker side. The
    // batch route only checks the history-sync bucket when the header is present.
    await POST(
      makeBatchRequest({
        ...makeEnvelope({ kind: 'chat_event_batch', isLatest: false }),
        events: makeEvents(3),
      }),
    );
    expect(mockCheckHistorySyncBatch).not.toHaveBeenCalled();
    expect(mockInsertChatEventBatch).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Schema: historySync: false rejected
// ---------------------------------------------------------------------------

describe('history_sync_rate_limit, historySync: false is rejected by schema', () => {
  it('returns 400 when historySync field is false (z.literal(true) constraint)', async () => {
    const res = await POST(
      makeBatchRequest({
        ...makeEnvelope({
          kind: 'chat_event_batch',
          isLatest: false,
          historySync: {
            historySync: false, // schema requires literal true
            sessionId: SESSION_ID,
            batchIndex: 0,
          },
        }),
        events: makeEvents(1),
      }),
    );
    expect(res.status).toBe(400);
    expect(mockCheckHistorySyncBatch).not.toHaveBeenCalled();
    expect(mockInsertChatEventBatch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Cross-session isolation, buckets are per-sessionId
// ---------------------------------------------------------------------------

describe('history_sync_rate_limit, cross-session: each session uses its own bucket', () => {
  it('charges the history bucket with the correct sessionId for each session', async () => {
    const SESSION_B = 'session-b';

    await POST(
      makeBatchRequest({
        ...makeEnvelope({
          kind: 'chat_event_batch',
          isLatest: false,
          sessionId: SESSION_ID,
          historySync: makeHistorySyncHeader(SESSION_ID, 0),
        }),
        events: makeEvents(3),
      }),
    );
    await POST(
      makeBatchRequest({
        ...makeEnvelope({
          kind: 'chat_event_batch',
          isLatest: false,
          sessionId: SESSION_B,
          historySync: makeHistorySyncHeader(SESSION_B, 0),
        }),
        events: makeEvents(7),
      }),
    );

    expect(mockCheckHistorySyncBatch).toHaveBeenCalledTimes(2);
    const calls = mockCheckHistorySyncBatch.mock.calls as [string, number][];
    const [call1, call2] = calls;
    // First call must have been for SESSION_ID with count 3.
    expect(call1![0]).toBe(SESSION_ID);
    expect(call1![1]).toBe(3);
    // Second call must have been for SESSION_B with count 7.
    expect(call2![0]).toBe(SESSION_B);
    expect(call2![1]).toBe(7);
  });
});

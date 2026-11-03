/**
 * webhook-deliveries repository, unit tests.
 *
 * Mocks the `col<T>(name)` function from `@/lib/mongo` so no real MongoDB
 * connection is required. Each test constructs a fake in-memory collection
 * that satisfies the subset of the MongoDB driver API that the repository uses.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WEBHOOK_DELIVERY_RETRY_DELAYS_SEC, WEBHOOK_MAX_ATTEMPTS } from '@hmddevs/protocol';

// ---- module mocks ---------------------------------------------------------
vi.mock('@/lib/mongo', () => ({
  col: vi.fn(),
}));

// ---- imports after mocks --------------------------------------------------
import { col } from '@/lib/mongo';
import {
  enqueueDelivery,
  claimDueDeliveries,
  markSent,
  markFailed,
  type WebhookDeliveryDoc,
} from '@/lib/repositories/webhook-deliveries';

// ---------------------------------------------------------------------------

const mockCol = col as ReturnType<typeof vi.fn>;

/** Builds a minimal in-memory collection stub. */
function makeCollectionStub(docs: WebhookDeliveryDoc[] = []) {
  const store = [...docs];

  const stub = {
    createIndexes: vi.fn().mockResolvedValue(undefined),
    insertOne: vi.fn((doc: WebhookDeliveryDoc) => {
      store.push({ ...doc });
      return Promise.resolve({ acknowledged: true });
    }),
    find: vi.fn((query: Record<string, unknown>) => {
      let results = [...store];
      // Filter by status.
      if (query.status !== undefined) {
        results = results.filter((d) => d.status === query.status);
      }
      // Filter nextAttemptAt <= now.
      if (query.nextAttemptAt && typeof query.nextAttemptAt === 'object') {
        const lte = (query.nextAttemptAt as Record<string, Date>)['$lte'];
        if (lte)
          results = results.filter((d) => d.nextAttemptAt !== null && d.nextAttemptAt <= lte);
      }
      return {
        sort: () => ({
          limit: (n: number) => ({
            toArray: () => Promise.resolve(results.slice(0, n)),
          }),
        }),
      };
    }),
    findOne: vi.fn((query: Record<string, string>) => {
      const doc = store.find((d) => d.deliveryId === query.deliveryId);
      return Promise.resolve(doc ?? null);
    }),
    updateOne: vi.fn((query: Record<string, string>, update: Record<string, unknown>) => {
      const idx = store.findIndex((d) => d.deliveryId === query.deliveryId);
      if (idx === -1) return Promise.resolve({ modifiedCount: 0 });
      const set = (update['$set'] ?? {}) as Partial<WebhookDeliveryDoc>;
      const inc = (update['$inc'] ?? {}) as Record<string, number>;
      store[idx] = { ...store[idx]!, ...set };
      for (const [k, v] of Object.entries(inc)) {
        const row = store[idx] as unknown as Record<string, unknown>;
        row[k] = ((row[k] as number) ?? 0) + v;
      }
      return Promise.resolve({ modifiedCount: 1 });
    }),
    _store: store,
  };

  return stub;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------

describe('enqueueDelivery, defaults', () => {
  it('creates a doc with status=pending, attempts=0, expiresAt=createdAt+14d', async () => {
    const stub = makeCollectionStub();
    mockCol.mockResolvedValue(stub);

    const before = new Date();
    const doc = await enqueueDelivery({
      routeId: 'whr_r1',
      eventId: 'evt-uuid-1',
      eventType: 'message.queued',
      payload: '{}',
      url: 'https://recv.test/hook',
    });
    const after = new Date();

    expect(doc.status).toBe('pending');
    expect(doc.attempts).toBe(0);
    expect(doc.nextAttemptAt).not.toBeNull();

    const ttlMs = 14 * 24 * 60 * 60 * 1_000;
    expect(doc.expiresAt.getTime() - doc.createdAt.getTime()).toBeCloseTo(ttlMs, -3);
    expect(doc.createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(doc.createdAt.getTime()).toBeLessThanOrEqual(after.getTime());

    expect(stub.insertOne).toHaveBeenCalledOnce();
  });
});

describe('claimDueDeliveries', () => {
  it('returns docs whose nextAttemptAt <= now', async () => {
    const now = new Date();
    const dueDoc: WebhookDeliveryDoc = {
      deliveryId: 'del-due',
      routeId: 'r1',
      eventId: 'e1',
      eventType: 'message.queued',
      payload: '{}',
      url: 'https://x.test',
      status: 'pending',
      attempts: 0,
      nextAttemptAt: new Date(now.getTime() - 1_000),
      lastAttemptAt: null,
      lastResponseStatus: null,
      lastError: null,
      createdAt: now,
      expiresAt: new Date(now.getTime() + 1_000),
    };
    const futureDoc: WebhookDeliveryDoc = {
      ...dueDoc,
      deliveryId: 'del-future',
      nextAttemptAt: new Date(now.getTime() + 60_000),
    };

    const stub = makeCollectionStub([dueDoc, futureDoc]);
    mockCol.mockResolvedValue(stub);

    const results = await claimDueDeliveries(now, 10);
    expect(results.map((d) => d.deliveryId)).toEqual(['del-due']);
  });

  it('excludes docs with nextAttemptAt in the future', async () => {
    const now = new Date();
    const futureDoc: WebhookDeliveryDoc = {
      deliveryId: 'del-future-only',
      routeId: 'r1',
      eventId: 'e1',
      eventType: 'message.sent',
      payload: '{}',
      url: 'https://x.test',
      status: 'pending',
      attempts: 0,
      nextAttemptAt: new Date(now.getTime() + 5_000),
      lastAttemptAt: null,
      lastResponseStatus: null,
      lastError: null,
      createdAt: now,
      expiresAt: new Date(now.getTime() + 1_000),
    };

    const stub = makeCollectionStub([futureDoc]);
    mockCol.mockResolvedValue(stub);

    const results = await claimDueDeliveries(now, 10);
    expect(results).toHaveLength(0);
  });
});

describe('markFailed, mid-run retry', () => {
  it('advances attempts and sets nextAttemptAt ~= now + retryDelaySec * 1000', async () => {
    const now = new Date();
    const doc: WebhookDeliveryDoc = {
      deliveryId: 'del-fail-1',
      routeId: 'r1',
      eventId: 'e1',
      eventType: 'message.queued',
      payload: '{}',
      url: 'https://x.test',
      status: 'pending',
      attempts: 0,
      nextAttemptAt: now,
      lastAttemptAt: null,
      lastResponseStatus: null,
      lastError: null,
      createdAt: now,
      expiresAt: new Date(now.getTime() + 1_000),
    };

    const stub = makeCollectionStub([doc]);
    mockCol.mockResolvedValue(stub);

    const result = await markFailed('del-fail-1', { httpStatus: 502, error: 'bad gateway' });

    expect(result.status).toBe('pending');
    expect(result.attempts).toBe(1);
    expect(result.nextAttemptAt).not.toBeNull();
    // First retry delay is 30 s.
    const expectedDelay = (WEBHOOK_DELIVERY_RETRY_DELAYS_SEC[0] ?? 30) * 1_000;
    expect(result.nextAttemptAt!.getTime()).toBeGreaterThanOrEqual(
      now.getTime() + expectedDelay - 100,
    );
    expect(result.nextAttemptAt!.getTime()).toBeLessThanOrEqual(
      now.getTime() + expectedDelay + 200,
    );
  });
});

describe('markFailed, final attempt abandonment', () => {
  it('sets status=abandoned once attempts reaches WEBHOOK_MAX_ATTEMPTS', async () => {
    const now = new Date();
    // Pre-fill attempts at max-1 so the next markFailed crosses the threshold.
    const doc: WebhookDeliveryDoc = {
      deliveryId: 'del-abandon',
      routeId: 'r1',
      eventId: 'e1',
      eventType: 'message.queued',
      payload: '{}',
      url: 'https://x.test',
      status: 'pending',
      attempts: WEBHOOK_MAX_ATTEMPTS - 1,
      nextAttemptAt: now,
      lastAttemptAt: null,
      lastResponseStatus: null,
      lastError: null,
      createdAt: now,
      expiresAt: new Date(now.getTime() + 1_000),
    };

    const stub = makeCollectionStub([doc]);
    mockCol.mockResolvedValue(stub);

    const result = await markFailed('del-abandon', { httpStatus: null, error: 'timeout' });

    expect(result.status).toBe('abandoned');
    expect(result.nextAttemptAt).toBeNull();
    expect(result.attempts).toBe(WEBHOOK_MAX_ATTEMPTS);
  });
});

describe('markSent', () => {
  it('sets status=sent, clears nextAttemptAt, increments attempts', async () => {
    const now = new Date();
    const doc: WebhookDeliveryDoc = {
      deliveryId: 'del-sent',
      routeId: 'r1',
      eventId: 'e1',
      eventType: 'message.queued',
      payload: '{}',
      url: 'https://x.test',
      status: 'pending',
      attempts: 1,
      nextAttemptAt: now,
      lastAttemptAt: null,
      lastResponseStatus: null,
      lastError: null,
      createdAt: now,
      expiresAt: new Date(now.getTime() + 1_000),
    };

    const stub = makeCollectionStub([doc]);
    mockCol.mockResolvedValue(stub);

    await markSent('del-sent', 200);

    const updated = stub._store.find((d) => d.deliveryId === 'del-sent');
    expect(updated?.status).toBe('sent');
    expect(updated?.nextAttemptAt).toBeNull();
    expect(updated?.lastResponseStatus).toBe(200);
    // attempts is incremented via $inc in the real implementation.
    expect(updated?.attempts).toBe(2);
  });
});

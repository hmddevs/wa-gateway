/**
 * Cron webhook-deliver route, integration tests.
 *
 * Mocks:
 *   - `@/lib/repositories/webhook-deliveries`, in-memory delivery store
 *   - `@/lib/repositories/webhook-routes`, stub route with a known plaintext secret
 *   - `@/lib/webhook-secret-crypto`, openSecret returns the plaintext directly
 *   - `@/lib/webhook-delivery`, attemptDelivery is a stub controllable per-test
 *   - `@/lib/logger`, silenced
 *
 * `isCronAuthorized` is not mocked; we set NODE_ENV=test so it returns true
 * when no CRON_SECRET is configured.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WEBHOOK_MAX_ATTEMPTS } from '@hmddevs/protocol';

// ---- module mocks ---------------------------------------------------------
vi.mock('@/lib/repositories/webhook-deliveries', () => ({
  claimDueDeliveries: vi.fn(),
  markSent: vi.fn(),
  markFailed: vi.fn(),
  markAbandoned: vi.fn(),
}));

vi.mock('@/lib/repositories/webhook-routes', () => ({
  getRoute: vi.fn(),
  recordDeliveryOutcome: vi.fn(),
}));

vi.mock('@/lib/webhook-secret-crypto', () => ({
  openSecret: vi.fn(() => 'plaintext-secret'),
}));

vi.mock('@/lib/webhook-delivery', () => ({
  attemptDelivery: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ---- imports after mocks --------------------------------------------------
import { GET } from '@/app/api/cron/webhook-deliver/route';
import {
  claimDueDeliveries,
  markSent,
  markFailed,
  markAbandoned,
} from '@/lib/repositories/webhook-deliveries';
import { getRoute, recordDeliveryOutcome } from '@/lib/repositories/webhook-routes';
import { openSecret } from '@/lib/webhook-secret-crypto';
import { attemptDelivery } from '@/lib/webhook-delivery';
import type { WebhookDeliveryDoc } from '@/lib/repositories/webhook-deliveries';
import type { WebhookRouteDoc } from '@/lib/repositories/webhook-routes';
import type { DeliveryAttemptResult } from '@/lib/webhook-delivery';

// ---------------------------------------------------------------------------

const mockClaimDueDeliveries = claimDueDeliveries as ReturnType<typeof vi.fn>;
const mockMarkSent = markSent as ReturnType<typeof vi.fn>;
const mockMarkFailed = markFailed as ReturnType<typeof vi.fn>;
const mockMarkAbandoned = markAbandoned as ReturnType<typeof vi.fn>;
const mockGetRoute = getRoute as ReturnType<typeof vi.fn>;
const mockRecordDeliveryOutcome = recordDeliveryOutcome as ReturnType<typeof vi.fn>;
const mockOpenSecret = openSecret as ReturnType<typeof vi.fn>;
const mockAttemptDelivery = attemptDelivery as ReturnType<typeof vi.fn>;

function makeDelivery(overrides: Partial<WebhookDeliveryDoc> = {}): WebhookDeliveryDoc {
  const now = new Date();
  return {
    deliveryId: 'del-cron-1',
    routeId: 'whr_r1',
    eventId: 'evt-1',
    eventType: 'message.queued',
    payload: '{"type":"message.queued"}',
    url: 'https://consumer.test/hook',
    status: 'pending',
    attempts: 0,
    nextAttemptAt: now,
    lastAttemptAt: null,
    lastResponseStatus: null,
    lastError: null,
    createdAt: now,
    expiresAt: new Date(now.getTime() + 14 * 24 * 60 * 60 * 1_000),
    ...overrides,
  };
}

function makeRoute(overrides: Partial<WebhookRouteDoc> = {}): WebhookRouteDoc {
  return {
    routeId: 'whr_r1',
    scope: { kind: 'apiKey', apiKeyId: 'key_abc' },
    url: 'https://consumer.test/hook',
    secretCiphertext: 'enc',
    secretIv: 'iv',
    secretAuthTag: 'tag',
    secretFingerprint: 'abcdefg1234',
    events: ['message.queued'],
    active: true,
    description: null,
    createdAt: new Date(),
    createdBy: 'admin',
    lastDeliveryAt: null,
    lastDeliveryStatus: null,
    lastDeliveryHttpStatus: null,
    revokedAt: null,
    ...overrides,
  };
}

function makeCronRequest(): Request {
  return new Request('https://wa.example.com/api/cron/webhook-deliver', {
    method: 'GET',
    headers: { authorization: 'Bearer test-cron-secret' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  (process.env as Record<string, string | undefined>).NODE_ENV = 'test';
  process.env.CRON_SECRET = 'test-cron-secret';
  // Mark sent/failed return resolved promises by default.
  mockMarkSent.mockResolvedValue(undefined);
  mockMarkFailed.mockResolvedValue({
    status: 'pending',
    nextAttemptAt: new Date(Date.now() + 30_000),
    attempts: 1,
  });
  mockMarkAbandoned.mockResolvedValue(undefined);
  mockRecordDeliveryOutcome.mockResolvedValue(undefined);
  mockOpenSecret.mockReturnValue('plaintext-secret');
});

// ---------------------------------------------------------------------------

describe('cron deliverer, happy path (200 response)', () => {
  it('marks delivery as sent when consumer responds 200', async () => {
    const delivery = makeDelivery();
    const route = makeRoute();

    mockClaimDueDeliveries.mockResolvedValue([delivery]);
    mockGetRoute.mockResolvedValue(route);
    const attemptResult: DeliveryAttemptResult = {
      ok: true,
      httpStatus: 200,
      durationMs: 12,
      error: null,
    };
    mockAttemptDelivery.mockResolvedValue(attemptResult);

    const res = await GET(makeCronRequest());
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, number>;
    expect(body.sent).toBe(1);
    expect(body.failed).toBe(0);

    expect(mockMarkSent).toHaveBeenCalledOnce();
    expect(mockMarkSent).toHaveBeenCalledWith(delivery.deliveryId, 200);
    expect(mockRecordDeliveryOutcome).toHaveBeenCalledWith(
      route.routeId,
      expect.objectContaining({ status: 'sent' }),
    );
  });

  it('passes the signature header to the consumer (attemptDelivery is called with the delivery payload)', async () => {
    const delivery = makeDelivery();
    const route = makeRoute();

    mockClaimDueDeliveries.mockResolvedValue([delivery]);
    mockGetRoute.mockResolvedValue(route);
    mockAttemptDelivery.mockResolvedValue({
      ok: true,
      httpStatus: 200,
      durationMs: 5,
      error: null,
    });

    await GET(makeCronRequest());

    // attemptDelivery receives the delivery's exact payload bytes.
    expect(mockAttemptDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: delivery.payload,
        url: delivery.url,
        deliveryId: delivery.deliveryId,
      }),
    );
  });
});

describe('cron deliverer, failed delivery (502 response)', () => {
  it('reschedules delivery without marking it sent when consumer returns 502', async () => {
    const delivery = makeDelivery();
    const route = makeRoute();

    mockClaimDueDeliveries.mockResolvedValue([delivery]);
    mockGetRoute.mockResolvedValue(route);
    const attemptResult: DeliveryAttemptResult = {
      ok: false,
      httpStatus: 502,
      durationMs: 20,
      error: 'non-2xx status 502',
    };
    mockAttemptDelivery.mockResolvedValue(attemptResult);

    const res = await GET(makeCronRequest());
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, number>;
    expect(body.failed).toBe(1);
    expect(body.sent).toBe(0);

    expect(mockMarkSent).not.toHaveBeenCalled();
    expect(mockMarkFailed).toHaveBeenCalledWith(delivery.deliveryId, {
      httpStatus: 502,
      error: 'non-2xx status 502',
    });
    expect(mockRecordDeliveryOutcome).toHaveBeenCalledWith(
      route.routeId,
      expect.objectContaining({ status: 'failed' }),
    );
  });
});

describe('cron deliverer, exhausted retries', () => {
  it('abandons delivery when attempts already equals WEBHOOK_MAX_ATTEMPTS - 1', async () => {
    const delivery = makeDelivery({ attempts: WEBHOOK_MAX_ATTEMPTS - 1 });
    const route = makeRoute();

    mockClaimDueDeliveries.mockResolvedValue([delivery]);
    mockGetRoute.mockResolvedValue(route);
    mockAttemptDelivery.mockResolvedValue({
      ok: false,
      httpStatus: 503,
      durationMs: 10,
      error: 'non-2xx status 503',
    });
    // markFailed returns abandoned when attempts reaches the max.
    mockMarkFailed.mockResolvedValue({
      status: 'abandoned',
      nextAttemptAt: null,
      attempts: WEBHOOK_MAX_ATTEMPTS,
    });

    const res = await GET(makeCronRequest());
    const body = (await res.json()) as Record<string, number>;

    expect(body.abandoned).toBe(1);
    expect(body.sent).toBe(0);
  });
});

describe('cron deliverer, empty queue', () => {
  it('returns 200 with zero counts when there are no due deliveries', async () => {
    mockClaimDueDeliveries.mockResolvedValue([]);

    const res = await GET(makeCronRequest());
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, number>;
    expect(body.scanned).toBe(0);
    expect(body.sent).toBe(0);
  });
});

describe('cron deliverer, secret decrypt failure', () => {
  it('abandons delivery immediately instead of burning retry slots when openSecret throws', async () => {
    const delivery = makeDelivery();
    const route = makeRoute();

    mockClaimDueDeliveries.mockResolvedValue([delivery]);
    mockGetRoute.mockResolvedValue(route);
    mockOpenSecret.mockImplementation(() => {
      throw new Error('auth tag mismatch');
    });

    const res = await GET(makeCronRequest());
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, number>;
    expect(body.abandoned).toBe(1);
    expect(body.failed).toBe(0);
    expect(body.sent).toBe(0);

    expect(mockMarkAbandoned).toHaveBeenCalledOnce();
    expect(mockMarkAbandoned).toHaveBeenCalledWith(delivery.deliveryId, 'secret_decrypt_failed');
    expect(mockMarkFailed).not.toHaveBeenCalled();
    expect(mockAttemptDelivery).not.toHaveBeenCalled();
    expect(mockRecordDeliveryOutcome).not.toHaveBeenCalled();
  });
});

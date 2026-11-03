/**
 * webhook-dispatch.ts, unit tests.
 *
 * Mocks `./repositories/webhook-routes` (findMatchingRoutes) and
 * `./repositories/webhook-deliveries` (enqueueDelivery) at the module level.
 * The `server-only` guard is neutralised by the vitest.config.ts alias.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- module mocks ---------------------------------------------------------
// Must be declared before any imports that reference the mocked modules.
vi.mock('@/lib/repositories/webhook-routes', () => ({
  findMatchingRoutes: vi.fn(),
}));

vi.mock('@/lib/repositories/webhook-deliveries', () => ({
  enqueueDelivery: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// ---- imports after mocks --------------------------------------------------
import { dispatchEvent } from '@/lib/webhook-dispatch';
import { findMatchingRoutes } from '@/lib/repositories/webhook-routes';
import { enqueueDelivery } from '@/lib/repositories/webhook-deliveries';
import type { WebhookDeliveryDoc } from '@/lib/repositories/webhook-deliveries';
import type { WebhookRouteDoc } from '@/lib/repositories/webhook-routes';

// ---------------------------------------------------------------------------

const mockFindMatchingRoutes = findMatchingRoutes as ReturnType<typeof vi.fn>;
const mockEnqueueDelivery = enqueueDelivery as ReturnType<typeof vi.fn>;

function makeRoute(overrides: Partial<WebhookRouteDoc> = {}): WebhookRouteDoc {
  return {
    routeId: 'whr_test-route-1',
    scope: { kind: 'apiKey', apiKeyId: 'key_abc' },
    url: 'https://consumer.test/webhook',
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

function makeDeliveryDoc(routeId: string): WebhookDeliveryDoc {
  const now = new Date();
  return {
    deliveryId: 'del-uuid-1',
    routeId,
    eventId: 'evt-uuid-1',
    eventType: 'message.queued',
    payload: '{}',
    url: 'https://consumer.test/webhook',
    status: 'pending',
    attempts: 0,
    nextAttemptAt: now,
    lastAttemptAt: null,
    lastResponseStatus: null,
    lastError: null,
    createdAt: now,
    expiresAt: new Date(now.getTime() + 14 * 24 * 60 * 60 * 1_000),
  };
}

const baseEvent = {
  type: 'message.queued' as const,
  eventId: '00000000-0000-4000-8000-000000000010',
  at: new Date().toISOString(),
  sessionId: 'session-a',
  messageId: '00000000-0000-4000-8000-000000000011',
  to: '+447700900123' as const,
  category: 'transactional' as const,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('dispatchEvent, one matching active route', () => {
  it('enqueues exactly one delivery with the canonical-JSON payload', async () => {
    const route = makeRoute();
    mockFindMatchingRoutes.mockResolvedValue([route]);
    mockEnqueueDelivery.mockResolvedValue(makeDeliveryDoc(route.routeId));

    const result = await dispatchEvent(baseEvent, { apiKeyId: 'key_abc' });

    expect(result.deliveriesQueued).toBe(1);
    expect(result.routesMatched).toBe(1);
    expect(mockEnqueueDelivery).toHaveBeenCalledOnce();

    const call = mockEnqueueDelivery.mock.calls[0] as [{ payload: string; routeId: string }];
    // Payload must be the canonical JSON of the event (string, parseable).
    expect(() => JSON.parse(call[0].payload)).not.toThrow();
    expect(call[0].routeId).toBe(route.routeId);
  });
});

describe('dispatchEvent, route active=false', () => {
  it('does not enqueue when findMatchingRoutes returns no active routes', async () => {
    // The repository already filters by active=true, so it returns empty.
    mockFindMatchingRoutes.mockResolvedValue([]);

    const result = await dispatchEvent(baseEvent, { apiKeyId: 'key_abc' });

    expect(result.deliveriesQueued).toBe(0);
    expect(result.routesMatched).toBe(0);
    expect(mockEnqueueDelivery).not.toHaveBeenCalled();
  });
});

describe('dispatchEvent, event type not in route.events', () => {
  it('does not enqueue when no routes match the event type', async () => {
    // findMatchingRoutes already filters by eventType; empty means no match.
    mockFindMatchingRoutes.mockResolvedValue([]);

    const inboundEvent = {
      type: 'inbound.received' as const,
      eventId: '00000000-0000-4000-8000-000000000020',
      at: new Date().toISOString(),
      sessionId: 'session-a',
      waMessageId: 'wa-msg-1',
      from: '+447700900999' as const,
      content: { type: 'text' as const, text: 'hello' },
    };

    const result = await dispatchEvent(inboundEvent, { apiKeyId: 'key_abc' });

    expect(result.deliveriesQueued).toBe(0);
    expect(mockEnqueueDelivery).not.toHaveBeenCalled();
  });
});

describe('dispatchEvent, multiple matching routes', () => {
  it('enqueues one delivery per matching route', async () => {
    const route1 = makeRoute({ routeId: 'whr_r1', scope: { kind: 'apiKey', apiKeyId: 'key_abc' } });
    const route2 = makeRoute({
      routeId: 'whr_r2',
      scope: { kind: 'session', sessionId: 'session-a' },
    });
    mockFindMatchingRoutes.mockResolvedValue([route1, route2]);
    mockEnqueueDelivery
      .mockResolvedValueOnce(makeDeliveryDoc(route1.routeId))
      .mockResolvedValueOnce(makeDeliveryDoc(route2.routeId));

    const result = await dispatchEvent(baseEvent, { apiKeyId: 'key_abc', sessionId: 'session-a' });

    expect(result.routesMatched).toBe(2);
    expect(result.deliveriesQueued).toBe(2);
    expect(mockEnqueueDelivery).toHaveBeenCalledTimes(2);
  });
});

describe('dispatchEvent, empty scope', () => {
  it('skips dispatch and returns zero counts when scope has no IDs', async () => {
    const result = await dispatchEvent(baseEvent, {});

    expect(result.deliveriesQueued).toBe(0);
    expect(result.routesMatched).toBe(0);
    expect(mockFindMatchingRoutes).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Defence-in-depth: chat_event* and contact_batch must never fan out
// ---------------------------------------------------------------------------

describe('dispatchEvent, defence-in-depth: chat_event type blocked', () => {
  it('returns zero deliveries for a chat_event type without querying routes', async () => {
    // WebhookEvent is a closed union that currently excludes chat_event*, but
    // the runtime guard must trip even if a future widening forgets this rule.
    const event = {
      ...baseEvent,
      type: 'chat_event' as unknown as typeof baseEvent.type,
    };

    const result = await dispatchEvent(event, { sessionId: 'session-a' });

    expect(result.deliveriesQueued).toBe(0);
    expect(result.routesMatched).toBe(0);
    expect(mockFindMatchingRoutes).not.toHaveBeenCalled();
    expect(mockEnqueueDelivery).not.toHaveBeenCalled();
  });

  it('returns zero deliveries for a chat_event_batch type', async () => {
    const event = {
      ...baseEvent,
      type: 'chat_event_batch' as unknown as typeof baseEvent.type,
    };

    const result = await dispatchEvent(event, { sessionId: 'session-a' });

    expect(result.deliveriesQueued).toBe(0);
    expect(result.routesMatched).toBe(0);
    expect(mockFindMatchingRoutes).not.toHaveBeenCalled();
    expect(mockEnqueueDelivery).not.toHaveBeenCalled();
  });
});

describe('dispatchEvent, defence-in-depth: contact_batch type blocked', () => {
  it('returns zero deliveries for a contact_batch type without querying routes', async () => {
    const event = {
      ...baseEvent,
      type: 'contact_batch' as unknown as typeof baseEvent.type,
    };

    const result = await dispatchEvent(event, { sessionId: 'session-a' });

    expect(result.deliveriesQueued).toBe(0);
    expect(result.routesMatched).toBe(0);
    expect(mockFindMatchingRoutes).not.toHaveBeenCalled();
    expect(mockEnqueueDelivery).not.toHaveBeenCalled();
  });
});

describe('dispatchEvent, regression: normal event type still routes', () => {
  it('enqueues a delivery for message.queued (the existing behaviour is unaffected)', async () => {
    const route = makeRoute();
    mockFindMatchingRoutes.mockResolvedValue([route]);
    mockEnqueueDelivery.mockResolvedValue(makeDeliveryDoc(route.routeId));

    const result = await dispatchEvent(baseEvent, { apiKeyId: 'key_abc' });

    expect(result.deliveriesQueued).toBe(1);
    expect(result.routesMatched).toBe(1);
    expect(mockFindMatchingRoutes).toHaveBeenCalledOnce();
    expect(mockEnqueueDelivery).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Defence-in-depth: chat_event* and contact_batch must never fan out
// ---------------------------------------------------------------------------

describe('dispatchEvent, defence-in-depth: chat_event type blocked', () => {
  it('returns zero deliveries for a chat_event type without querying routes', async () => {
    // WebhookEvent is a closed union that currently excludes chat_event*, but
    // the runtime guard must trip even if a future widening forgets this rule.
    const event = {
      ...baseEvent,
      type: 'chat_event' as unknown as typeof baseEvent.type,
    };

    const result = await dispatchEvent(event, { sessionId: 'session-a' });

    expect(result.deliveriesQueued).toBe(0);
    expect(result.routesMatched).toBe(0);
    expect(mockFindMatchingRoutes).not.toHaveBeenCalled();
    expect(mockEnqueueDelivery).not.toHaveBeenCalled();
  });

  it('returns zero deliveries for a chat_event_batch type', async () => {
    const event = {
      ...baseEvent,
      type: 'chat_event_batch' as unknown as typeof baseEvent.type,
    };

    const result = await dispatchEvent(event, { sessionId: 'session-a' });

    expect(result.deliveriesQueued).toBe(0);
    expect(result.routesMatched).toBe(0);
    expect(mockFindMatchingRoutes).not.toHaveBeenCalled();
    expect(mockEnqueueDelivery).not.toHaveBeenCalled();
  });
});

describe('dispatchEvent, defence-in-depth: contact_batch type blocked', () => {
  it('returns zero deliveries for a contact_batch type without querying routes', async () => {
    const event = {
      ...baseEvent,
      type: 'contact_batch' as unknown as typeof baseEvent.type,
    };

    const result = await dispatchEvent(event, { sessionId: 'session-a' });

    expect(result.deliveriesQueued).toBe(0);
    expect(result.routesMatched).toBe(0);
    expect(mockFindMatchingRoutes).not.toHaveBeenCalled();
    expect(mockEnqueueDelivery).not.toHaveBeenCalled();
  });
});

describe('dispatchEvent, regression: normal event type still routes', () => {
  it('enqueues a delivery for message.queued (the existing behaviour is unaffected)', async () => {
    const route = makeRoute();
    mockFindMatchingRoutes.mockResolvedValue([route]);
    mockEnqueueDelivery.mockResolvedValue(makeDeliveryDoc(route.routeId));

    const result = await dispatchEvent(baseEvent, { apiKeyId: 'key_abc' });

    expect(result.deliveriesQueued).toBe(1);
    expect(result.routesMatched).toBe(1);
    expect(mockFindMatchingRoutes).toHaveBeenCalledOnce();
    expect(mockEnqueueDelivery).toHaveBeenCalledOnce();
  });
});

/**
 * POST /v1/admin/webhooks/:id/test, synchronous test delivery.
 *
 * Mocked boundaries:
 *   - @/lib/require-admin
 *   - @/lib/repositories/webhook-routes, getRoute
 *   - @/lib/webhook-secret-crypto, openSecret
 *   - @/lib/webhook-delivery, attemptDelivery
 *   - @/lib/repositories/audit, appendAudit
 *   - @/lib/logger, silenced
 *   - @/lib/request-id, mintRequestId
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/require-admin', () => ({ requireAdmin: vi.fn() }));
vi.mock('@/lib/repositories/webhook-routes', () => ({ getRoute: vi.fn() }));
vi.mock('@/lib/webhook-secret-crypto', () => ({ openSecret: vi.fn(() => 'plaintext-secret') }));
vi.mock('@/lib/webhook-delivery', () => ({ attemptDelivery: vi.fn() }));
vi.mock('@/lib/repositories/audit', () => ({ appendAudit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/request-id', () => ({ mintRequestId: vi.fn(() => 'req-test') }));

import { POST } from '@/app/v1/admin/webhooks/[id]/test/route';
import { requireAdmin } from '@/lib/require-admin';
import { getRoute } from '@/lib/repositories/webhook-routes';
import { openSecret } from '@/lib/webhook-secret-crypto';
import { attemptDelivery } from '@/lib/webhook-delivery';
import { appendAudit } from '@/lib/repositories/audit';
import type { WebhookRouteDoc } from '@/lib/repositories/webhook-routes';

const mockRequireAdmin = requireAdmin as ReturnType<typeof vi.fn>;
const mockGetRoute = getRoute as ReturnType<typeof vi.fn>;
const mockOpenSecret = openSecret as ReturnType<typeof vi.fn>;
const mockAttemptDelivery = attemptDelivery as ReturnType<typeof vi.fn>;
const mockAppendAudit = appendAudit as ReturnType<typeof vi.fn>;

function authedAdmin() {
  return {
    ok: true as const,
    admin: { email: 'admin@hmd.test', sessionId: 'sess-1', webauthnFreshAt: new Date() },
  };
}

function makeRoute(overrides: Partial<WebhookRouteDoc> = {}): WebhookRouteDoc {
  return {
    routeId: 'whr_test',
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

function makeReq(): Request {
  return new Request('http://localhost/v1/admin/webhooks/whr_test/test', { method: 'POST' });
}

function ctx(id = 'whr_test'): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockOpenSecret.mockReturnValue('plaintext-secret');
});

describe('POST /v1/admin/webhooks/:id/test, auth', () => {
  it('returns 401 when admin guard rejects without webauthn step-up', async () => {
    mockRequireAdmin.mockResolvedValue({ ok: false, status: 401, message: 'Not signed in' });
    const res = await POST(makeReq(), ctx());
    expect(res.status).toBe(401);
    expect(mockGetRoute).not.toHaveBeenCalled();
    expect(mockAttemptDelivery).not.toHaveBeenCalled();
  });

  it('returns 403 when webauthn step-up is required', async () => {
    mockRequireAdmin.mockResolvedValue({
      ok: false,
      status: 403,
      message: 'WebAuthn step-up required',
    });
    const res = await POST(makeReq(), ctx());
    expect(res.status).toBe(403);
    expect(mockAttemptDelivery).not.toHaveBeenCalled();
  });
});

describe('POST /v1/admin/webhooks/:id/test, route state', () => {
  beforeEach(() => mockRequireAdmin.mockResolvedValue(authedAdmin()));

  it('returns 404 when the route does not exist', async () => {
    mockGetRoute.mockResolvedValue(null);
    const res = await POST(makeReq(), ctx());
    expect(res.status).toBe(404);
    expect(mockAttemptDelivery).not.toHaveBeenCalled();
  });

  it('returns 404 when the route is revoked', async () => {
    mockGetRoute.mockResolvedValue(makeRoute({ revokedAt: new Date() }));
    const res = await POST(makeReq(), ctx());
    expect(res.status).toBe(404);
    expect(mockAttemptDelivery).not.toHaveBeenCalled();
  });

  it('returns 400 when the route is inactive', async () => {
    mockGetRoute.mockResolvedValue(makeRoute({ active: false }));
    const res = await POST(makeReq(), ctx());
    expect(res.status).toBe(400);
    expect(mockAttemptDelivery).not.toHaveBeenCalled();
  });
});

describe('POST /v1/admin/webhooks/:id/test, delivery', () => {
  beforeEach(() => {
    mockRequireAdmin.mockResolvedValue(authedAdmin());
    mockGetRoute.mockResolvedValue(makeRoute());
  });

  it('returns ok=true and 200 status when consumer responds 200', async () => {
    mockAttemptDelivery.mockResolvedValue({
      ok: true,
      httpStatus: 200,
      durationMs: 42,
      error: null,
    });

    const res = await POST(makeReq(), ctx());
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      ok: boolean;
      httpStatus: number | null;
      durationMs: number;
      error: string | null;
    };
    expect(body.ok).toBe(true);
    expect(body.httpStatus).toBe(200);
    expect(body.error).toBeNull();

    expect(mockAttemptDelivery).toHaveBeenCalledOnce();
    const arg = mockAttemptDelivery.mock.calls[0]![0] as {
      eventType: string;
      url: string;
      payload: string;
    };
    expect(arg.eventType).toBe('webhook.test');
    expect(arg.url).toBe('https://consumer.test/hook');
    // payload is canonical JSON of a webhook.test event
    const event = JSON.parse(arg.payload) as { type: string; message: string };
    expect(event.type).toBe('webhook.test');
    expect(event.message).toBe('This is a test webhook from HMD WA Gateway.');

    expect(mockAppendAudit).toHaveBeenCalledOnce();
    const auditMeta = (mockAppendAudit.mock.calls[0]![0] as { meta: { ok: boolean } }).meta;
    expect(auditMeta.ok).toBe(true);
  });

  it('returns ok=false with short error code when delivery fails (private IP)', async () => {
    mockAttemptDelivery.mockResolvedValue({
      ok: false,
      httpStatus: null,
      durationMs: 5,
      error: 'destination_private_ip_blocked',
    });

    const res = await POST(makeReq(), ctx());
    expect(res.status).toBe(200);

    const body = (await res.json()) as { ok: boolean; error: string | null };
    expect(body.ok).toBe(false);
    expect(body.error).toBe('destination_private_ip_blocked');
  });

  it('returns 500 when secret decrypt fails', async () => {
    mockOpenSecret.mockImplementation(() => {
      throw new Error('auth tag mismatch');
    });

    const res = await POST(makeReq(), ctx());
    expect(res.status).toBe(500);
    expect(mockAttemptDelivery).not.toHaveBeenCalled();
  });

  it('uses scoped sessionId in synthetic event when route is session-scoped', async () => {
    mockGetRoute.mockResolvedValue(
      makeRoute({ scope: { kind: 'session', sessionId: 'sess_xyz' } }),
    );
    mockAttemptDelivery.mockResolvedValue({
      ok: true,
      httpStatus: 204,
      durationMs: 9,
      error: null,
    });

    await POST(makeReq(), ctx());
    const arg = mockAttemptDelivery.mock.calls[0]![0] as { payload: string };
    const event = JSON.parse(arg.payload) as { sessionId: string };
    expect(event.sessionId).toBe('sess_xyz');
  });
});

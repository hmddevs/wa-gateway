/**
 * Body size guard for POST /v1/admin/webhooks and PATCH /v1/admin/webhooks/:id.
 *
 * Mocked boundaries:
 *   - @/lib/require-admin
 *   - @/lib/repositories/webhook-routes
 *   - @/lib/repositories/api-keys, @/lib/repositories/sessions
 *   - @/lib/repositories/webhook-deliveries
 *   - @/lib/repositories/audit, @/lib/logger, @/lib/request-id
 *   - @/lib/safe-fetch
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/require-admin', () => ({ requireAdmin: vi.fn() }));
vi.mock('@/lib/repositories/webhook-routes', () => ({
  createRoute: vi.fn(),
  listRoutes: vi.fn(),
  getRoute: vi.fn(),
  updateRoute: vi.fn(),
  revokeRoute: vi.fn(),
  publicView: (doc: unknown) => doc,
}));
vi.mock('@/lib/repositories/api-keys', () => ({ findById: vi.fn() }));
vi.mock('@/lib/repositories/sessions', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/repositories/webhook-deliveries', () => ({ abandonPendingForRoute: vi.fn() }));
vi.mock('@/lib/repositories/audit', () => ({ appendAudit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/request-id', () => ({ mintRequestId: vi.fn(() => 'req-test') }));
vi.mock('@/lib/safe-fetch', () => ({ resolveSafeHost: vi.fn().mockResolvedValue(undefined) }));

import { POST as createWebhook } from '@/app/v1/admin/webhooks/route';
import { PATCH as patchWebhook } from '@/app/v1/admin/webhooks/[id]/route';
import { requireAdmin } from '@/lib/require-admin';
import { createRoute, getRoute, updateRoute } from '@/lib/repositories/webhook-routes';

const mockRequireAdmin = requireAdmin as ReturnType<typeof vi.fn>;
const mockCreateRoute = createRoute as ReturnType<typeof vi.fn>;
const mockGetRoute = getRoute as ReturnType<typeof vi.fn>;
const mockUpdateRoute = updateRoute as ReturnType<typeof vi.fn>;

function authedAdmin() {
  return {
    ok: true as const,
    admin: { email: 'admin@hmd.test', sessionId: 'sess-1', webauthnFreshAt: new Date() },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAdmin.mockResolvedValue(authedAdmin());
});

function req(url: string, body: unknown, contentLength?: number): Request {
  const json = JSON.stringify(body);
  const headers = new Headers({ 'content-type': 'application/json' });
  headers.set('content-length', String(contentLength ?? json.length));
  return new Request(url, { method: 'POST', headers, body: json });
}

describe('POST /v1/admin/webhooks, body size guard', () => {
  it('rejects an oversize content-length with 413 before touching the DB', async () => {
    const res = await createWebhook(
      req(
        'http://localhost/v1/admin/webhooks',
        {
          scope: { kind: 'apiKey', apiKeyId: 'key_1' },
          url: 'https://x.test/h',
          events: ['message.queued'],
        },
        17 * 1024,
      ),
    );
    expect(res.status).toBe(413);
    expect(mockCreateRoute).not.toHaveBeenCalled();
  });

  it('processes a normal-size body', async () => {
    mockCreateRoute.mockResolvedValue({
      route: {
        routeId: 'whr_1',
        scope: { kind: 'apiKey', apiKeyId: 'key_1' },
        url: 'https://x.test/h',
        events: ['message.queued'],
        active: true,
        description: null,
        secretFingerprint: 'fp',
        createdAt: new Date(),
        createdBy: 'admin',
        lastDeliveryAt: null,
        lastDeliveryStatus: null,
        lastDeliveryHttpStatus: null,
        revokedAt: null,
      },
      secret: 'whsec_test',
    });
    const { findById } = await import('@/lib/repositories/api-keys');
    (findById as ReturnType<typeof vi.fn>).mockResolvedValue({ revokedAt: null });

    const res = await createWebhook(
      req('http://localhost/v1/admin/webhooks', {
        scope: { kind: 'apiKey', apiKeyId: 'key_1' },
        url: 'https://x.test/h',
        events: ['message.queued'],
      }),
    );
    expect(res.status).toBe(201);
  });
});

describe('PATCH /v1/admin/webhooks/:id, body size guard', () => {
  function ctx(id = 'whr_1') {
    return { params: Promise.resolve({ id }) };
  }

  it('rejects an oversize content-length with 413 before touching the DB', async () => {
    const res = await patchWebhook(
      req('http://localhost/v1/admin/webhooks/whr_1', { active: false }, 17 * 1024),
      ctx(),
    );
    expect(res.status).toBe(413);
    expect(mockGetRoute).not.toHaveBeenCalled();
  });

  it('processes a normal-size body', async () => {
    const existing = {
      routeId: 'whr_1',
      scope: { kind: 'apiKey', apiKeyId: 'key_1' },
      url: 'https://x.test/h',
      events: ['message.queued'],
      active: true,
      description: null,
      secretFingerprint: 'fp',
      createdAt: new Date(),
      createdBy: 'admin',
      lastDeliveryAt: null,
      lastDeliveryStatus: null,
      lastDeliveryHttpStatus: null,
      revokedAt: null,
    };
    mockGetRoute.mockResolvedValue(existing);
    mockUpdateRoute.mockResolvedValue({ ...existing, active: false });

    const res = await patchWebhook(
      req('http://localhost/v1/admin/webhooks/whr_1', { active: false }),
      ctx(),
    );
    expect(res.status).toBe(200);
  });
});

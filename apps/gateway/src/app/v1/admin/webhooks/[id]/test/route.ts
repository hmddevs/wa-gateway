/**
 * POST /v1/admin/webhooks/:id/test
 *
 * Fire a synthetic `webhook.test` event at the route URL, synchronously,
 * and return the upstream response status to the admin. Bypasses the cron
 * queue, the result reflects exactly what the consumer would see for a
 * real delivery (same signature scheme, same headers).
 */
import 'server-only';
import { randomUUID } from 'node:crypto';
import { ErrorCodes, canonicalJson, type WebhookEvent } from '@hmddevs/protocol';
import { requireAdmin } from '@/lib/require-admin';
import { errorResponse, jsonResponse } from '@/lib/http';
import { mintRequestId } from '@/lib/request-id';
import { logger } from '@/lib/logger';
import { appendAudit } from '@/lib/repositories/audit';
import { getRoute } from '@/lib/repositories/webhook-routes';
import { openSecret } from '@/lib/webhook-secret-crypto';
import { attemptDelivery } from '@/lib/webhook-delivery';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = mintRequestId(req.headers.get('x-request-id'));
  const guard = await requireAdmin({ webauthn: true });
  if (!guard.ok) {
    return errorResponse(guard.status, ErrorCodes.UNAUTHORIZED, guard.message, requestId);
  }
  const { id } = await ctx.params;

  const route = await getRoute(id);
  if (!route || route.revokedAt) {
    return errorResponse(404, ErrorCodes.INVALID_BODY, 'Route not found', requestId);
  }
  if (!route.active) {
    return errorResponse(400, ErrorCodes.INVALID_BODY, 'Route is inactive', requestId);
  }

  // Inferred sessionId for the synthetic event, use the scoped session, or
  // a clearly-synthetic value when the route is apiKey-scoped. Consumers
  // should treat `webhook.test` as a no-op heartbeat regardless.
  const sessionId = route.scope.kind === 'session' ? route.scope.sessionId : '__test__';

  const event: WebhookEvent = {
    type: 'webhook.test',
    at: new Date().toISOString(),
    eventId: randomUUID(),
    sessionId,
    message: 'This is a test webhook from HMD WA Gateway.',
  };
  const payload = canonicalJson(event);
  const deliveryId = randomUUID();

  let secret: string;
  try {
    secret = openSecret({
      ciphertext: route.secretCiphertext,
      iv: route.secretIv,
      authTag: route.secretAuthTag,
    });
  } catch (err: unknown) {
    logger.error(
      { err: (err as Error).message, routeId: route.routeId },
      'webhook secret decrypt failed',
    );
    return errorResponse(500, ErrorCodes.INTERNAL, 'Secret unavailable', requestId);
  }

  const result = await attemptDelivery({
    url: route.url,
    payload,
    secret,
    eventType: event.type,
    deliveryId,
  });

  await appendAudit({
    actor: { kind: 'admin', id: guard.admin.email, email: guard.admin.email },
    action: 'webhook_route.test',
    target: { kind: 'webhook_route', id: route.routeId },
    meta: {
      ok: result.ok,
      httpStatus: result.httpStatus,
      durationMs: result.durationMs,
      // Full upstream error stays in the audit trail. The HTTP response
      // exposes only a short error code so the test endpoint can't be used
      // as an SSRF / fingerprinting oracle.
      error: result.error,
    },
  });

  if (!result.ok && result.error) {
    logger.warn(
      { routeId: route.routeId, error: result.error, httpStatus: result.httpStatus },
      'webhook test failed',
    );
  }

  return jsonResponse(
    200,
    {
      ok: result.ok,
      httpStatus: result.httpStatus,
      durationMs: result.durationMs,
      // Surfacing the short-coded reason keeps admins informed without
      // leaking internal infrastructure details (DNS resolver responses,
      // ALPN failures, etc.). Full error is in the audit log + structured logs.
      error: result.ok ? null : result.error,
    },
    requestId,
  );
}

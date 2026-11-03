/**
 * Admin: webhook route patch / revoke.
 *
 *   PATCH  /v1/admin/webhooks/:id   → toggle active, update url/events/description
 *   DELETE /v1/admin/webhooks/:id   → revoke (sets revokedAt + active=false)
 */
import 'server-only';
import { z } from 'zod';
import { ErrorCodes, WebhookEventTypeSchema } from '@hmddevs/protocol';
import { requireAdmin } from '@/lib/require-admin';
import { errorResponse, jsonResponse } from '@/lib/http';
import { mintRequestId } from '@/lib/request-id';
import { appendAudit } from '@/lib/repositories/audit';
import { getRoute, revokeRoute, updateRoute } from '@/lib/repositories/webhook-routes';
import { abandonPendingForRoute } from '@/lib/repositories/webhook-deliveries';
import { resolveSafeHost } from '@/lib/safe-fetch';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PatchSchema = z
  .object({
    url: z.string().url().startsWith('https://').optional(),
    events: z.array(WebhookEventTypeSchema).min(1).optional(),
    active: z.boolean().optional(),
    description: z.string().max(256).nullable().optional(),
  })
  .refine(
    (v) =>
      v.url !== undefined ||
      v.events !== undefined ||
      v.active !== undefined ||
      v.description !== undefined,
    { message: 'No fields to update' },
  );

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = mintRequestId(req.headers.get('x-request-id'));
  const guard = await requireAdmin({ webauthn: true });
  if (!guard.ok) {
    return errorResponse(guard.status, ErrorCodes.UNAUTHORIZED, guard.message, requestId);
  }
  const { id } = await ctx.params;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return errorResponse(400, ErrorCodes.INVALID_BODY, 'Invalid JSON', requestId);
  }
  const parsed = PatchSchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(400, ErrorCodes.INVALID_BODY, parsed.error.message, requestId);
  }

  const before = await getRoute(id);
  if (!before || before.revokedAt) {
    return errorResponse(404, ErrorCodes.INVALID_BODY, 'Route not found', requestId);
  }

  if (parsed.data.url !== undefined && parsed.data.url !== before.url) {
    try {
      await resolveSafeHost(parsed.data.url);
    } catch (err: unknown) {
      return errorResponse(
        400,
        ErrorCodes.INVALID_BODY,
        `URL not allowed: ${(err as Error).message}`,
        requestId,
      );
    }
  }

  const after = await updateRoute(id, parsed.data);
  if (!after) {
    return errorResponse(404, ErrorCodes.INVALID_BODY, 'Route not found', requestId);
  }

  // If admin just deactivated the route, abandon all in-flight deliveries
  // immediately rather than burning the retry budget.
  if (parsed.data.active === false && before.active) {
    const abandoned = await abandonPendingForRoute(id, 'route_deactivated');
    if (abandoned > 0) {
      await appendAudit({
        actor: { kind: 'admin', id: guard.admin.email, email: guard.admin.email },
        action: 'webhook_delivery.abandon_bulk',
        target: { kind: 'webhook_route', id },
        meta: { count: abandoned, reason: 'route_deactivated' },
      });
    }
  }

  await appendAudit({
    actor: { kind: 'admin', id: guard.admin.email, email: guard.admin.email },
    action: 'webhook_route.update',
    target: { kind: 'webhook_route', id },
    meta: {
      changed: Object.keys(parsed.data),
      activeBefore: before.active,
      activeAfter: after.active,
    },
  });

  return jsonResponse(
    200,
    {
      route: {
        routeId: after.routeId,
        scope: after.scope,
        url: after.url,
        events: after.events,
        active: after.active,
        description: after.description,
        secretFingerprint: after.secretFingerprint,
        createdAt: after.createdAt,
        createdBy: after.createdBy,
        lastDeliveryAt: after.lastDeliveryAt,
        lastDeliveryStatus: after.lastDeliveryStatus,
        lastDeliveryHttpStatus: after.lastDeliveryHttpStatus,
        revokedAt: after.revokedAt,
      },
    },
    requestId,
  );
}

export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = mintRequestId(req.headers.get('x-request-id'));
  const guard = await requireAdmin({ webauthn: true });
  if (!guard.ok) {
    return errorResponse(guard.status, ErrorCodes.UNAUTHORIZED, guard.message, requestId);
  }
  const { id } = await ctx.params;

  const ok = await revokeRoute(id, guard.admin.email);
  if (!ok) {
    return errorResponse(
      404,
      ErrorCodes.INVALID_BODY,
      'Route not found or already revoked',
      requestId,
    );
  }

  // Abandon any pending deliveries for this route immediately.
  const abandoned = await abandonPendingForRoute(id, 'route_revoked');

  await appendAudit({
    actor: { kind: 'admin', id: guard.admin.email, email: guard.admin.email },
    action: 'webhook_route.revoke',
    target: { kind: 'webhook_route', id },
    meta: { abandonedDeliveries: abandoned },
  });

  return jsonResponse(200, { revoked: true, abandonedDeliveries: abandoned }, requestId);
}

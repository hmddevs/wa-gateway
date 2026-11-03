/**
 * Admin: webhook route management.
 *
 *   GET  /v1/admin/webhooks              → list (filter by ?apiKeyId / ?sessionId)
 *   POST /v1/admin/webhooks              → create (returns secret ONCE)
 *
 * Both endpoints require an admin session. POST additionally requires a
 * fresh WebAuthn step-up (mirror of `/api/admin/keys`).
 */
import 'server-only';
import { z } from 'zod';
import { ErrorCodes, WebhookEventTypeSchema, WebhookRouteScopeSchema } from '@hmddevs/protocol';
import { requireAdmin } from '@/lib/require-admin';
import { errorResponse, jsonResponse } from '@/lib/http';
import { mintRequestId } from '@/lib/request-id';
import { appendAudit } from '@/lib/repositories/audit';
import { findById as findApiKey } from '@/lib/repositories/api-keys';
import { getSession } from '@/lib/repositories/sessions';
import { createRoute, listRoutes, publicView } from '@/lib/repositories/webhook-routes';
import { resolveSafeHost } from '@/lib/safe-fetch';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 16 * 1024;

const CreateSchema = z.object({
  scope: WebhookRouteScopeSchema,
  url: z.string().url().startsWith('https://'),
  events: z.array(WebhookEventTypeSchema).min(1),
  description: z.string().max(256).optional(),
});

export async function GET(req: Request): Promise<Response> {
  const requestId = mintRequestId(req.headers.get('x-request-id'));
  const guard = await requireAdmin();
  if (!guard.ok) {
    return errorResponse(guard.status, ErrorCodes.UNAUTHORIZED, guard.message, requestId);
  }
  const url = new URL(req.url);
  const apiKeyId = url.searchParams.get('apiKeyId') ?? undefined;
  const sessionId = url.searchParams.get('sessionId') ?? undefined;
  const includeRevoked = url.searchParams.get('includeRevoked') === '1';
  const docs = await listRoutes({ apiKeyId, sessionId, includeRevoked });
  return jsonResponse(200, { routes: docs.map(publicView) }, requestId);
}

export async function POST(req: Request): Promise<Response> {
  const requestId = mintRequestId(req.headers.get('x-request-id'));
  const guard = await requireAdmin({ webauthn: true });
  if (!guard.ok) {
    return errorResponse(guard.status, ErrorCodes.UNAUTHORIZED, guard.message, requestId);
  }

  const len = Number(req.headers.get('content-length') ?? 0);
  if (len > MAX_BODY_BYTES) {
    return errorResponse(413, ErrorCodes.PAYLOAD_TOO_LARGE, 'Body too large', requestId);
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return errorResponse(400, ErrorCodes.INVALID_BODY, 'Invalid JSON', requestId);
  }
  const parsed = CreateSchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(400, ErrorCodes.INVALID_BODY, parsed.error.message, requestId);
  }

  // SSRF guard: reject URLs that resolve to private/loopback/link-local IPs
  // before we ever persist the route. The cron deliverer also rechecks at
  // delivery time (DNS could change), but blocking at write time stops
  // privately-resolving hostnames from sitting in the DB at all.
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

  // Validate the scope target exists, refuse to create routes pointing at
  // ghosts. Cheap sanity check; not a security boundary.
  if (parsed.data.scope.kind === 'apiKey') {
    const k = await findApiKey(parsed.data.scope.apiKeyId);
    if (!k || k.revokedAt) {
      return errorResponse(400, ErrorCodes.INVALID_BODY, 'apiKeyId not found', requestId);
    }
  } else {
    const s = await getSession(parsed.data.scope.sessionId);
    if (!s) {
      return errorResponse(400, ErrorCodes.INVALID_BODY, 'sessionId not found', requestId);
    }
  }

  const { route, secret } = await createRoute({
    scope: parsed.data.scope,
    url: parsed.data.url,
    events: parsed.data.events,
    description: parsed.data.description ?? null,
    createdBy: guard.admin.email,
  });

  await appendAudit({
    actor: { kind: 'admin', id: guard.admin.email, email: guard.admin.email },
    action: 'webhook_route.create',
    target: { kind: 'webhook_route', id: route.routeId },
    meta: {
      scopeKind: route.scope.kind,
      scopeRef: route.scope.kind === 'apiKey' ? route.scope.apiKeyId : route.scope.sessionId,
      events: route.events,
      // never log the URL fully, host only is enough for forensics
      urlHost: safeHost(route.url),
      secretFingerprint: route.secretFingerprint,
    },
  });

  return jsonResponse(
    201,
    {
      route: publicView(route),
      secret, // ONCE, never persisted plain
    },
    requestId,
  );
}

function safeHost(u: string): string {
  try {
    return new URL(u).host;
  } catch {
    return 'invalid';
  }
}

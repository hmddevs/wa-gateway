/**
 * Admin organization mutation.
 * PATCH  /api/admin/organizations/:id  → add or remove a sessionId (WebAuthn step-up)
 * DELETE /api/admin/organizations/:id  → delete the organization (WebAuthn step-up)
 *
 * Both mutations require WebAuthn step-up, mirroring the keys/sessions routes.
 */
import 'server-only';
import { z } from 'zod';
import { requireAdmin } from '@/lib/require-admin';
import { errorResponse, jsonResponse } from '@/lib/http';
import { ErrorCodes, SessionIdSchema } from '@hmddevs/protocol';
import { mintRequestId } from '@/lib/request-id';
import { getOrg, addSession, removeSession, deleteOrg } from '@/lib/repositories/organizations';
import { appendAudit } from '@/lib/repositories/audit';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 16 * 1024;

const PatchSchema = z.object({
  op: z.enum(['add', 'remove']),
  sessionId: SessionIdSchema,
});

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = mintRequestId(req.headers.get('x-request-id'));
  const guard = await requireAdmin({ webauthn: true });
  if (!guard.ok)
    return errorResponse(guard.status, ErrorCodes.UNAUTHORIZED, guard.message, requestId);

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
  const parsed = PatchSchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(400, ErrorCodes.INVALID_BODY, parsed.error.message, requestId);
  }

  const { id } = await ctx.params;
  const org =
    parsed.data.op === 'add'
      ? await addSession(id, parsed.data.sessionId)
      : await removeSession(id, parsed.data.sessionId);
  if (!org) return errorResponse(404, ErrorCodes.INVALID_BODY, 'Organization not found', requestId);

  await appendAudit({
    actor: { kind: 'admin', id: guard.admin.email, email: guard.admin.email },
    action: 'organization.update',
    target: { kind: 'organization', id },
    meta: { op: parsed.data.op, sessionId: parsed.data.sessionId, sessions: org.sessions },
  }).catch((err) => logger.warn({ err: (err as Error).message }, 'audit append failed'));

  return jsonResponse(
    200,
    { orgId: org.orgId, sessions: org.sessions, strategy: org.strategy },
    requestId,
  );
}

export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = mintRequestId(req.headers.get('x-request-id'));
  const guard = await requireAdmin({ webauthn: true });
  if (!guard.ok)
    return errorResponse(guard.status, ErrorCodes.UNAUTHORIZED, guard.message, requestId);

  const { id } = await ctx.params;
  const existing = await getOrg(id);
  if (!existing)
    return errorResponse(404, ErrorCodes.INVALID_BODY, 'Organization not found', requestId);

  await deleteOrg(id);

  await appendAudit({
    actor: { kind: 'admin', id: guard.admin.email, email: guard.admin.email },
    action: 'organization.delete',
    target: { kind: 'organization', id },
    meta: { sessions: existing.sessions },
  }).catch((err) => logger.warn({ err: (err as Error).message }, 'audit append failed'));

  return jsonResponse(200, { deleted: true }, requestId);
}

/**
 * DELETE /api/admin/keys/:id, revoke an API key.
 * PATCH  /api/admin/keys/:id, update mutable config (ipAllowlist, rateLimitPerMin).
 *
 * Both require WebAuthn step-up.
 */
import 'server-only';
import { z } from 'zod';
import { requireAdmin } from '@/lib/require-admin';
import { errorResponse, jsonResponse } from '@/lib/http';
import { ErrorCodes, OrgIdSchema } from '@hmddevs/protocol';
import { revokeKey, updateKey } from '@/lib/repositories/api-keys';
import { appendAudit } from '@/lib/repositories/audit';
import { mintRequestId } from '@/lib/request-id';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const OCTET = '(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const PREFIX = '(\\/([12]?\\d|3[0-2]))?';

/** IPv4 address or CIDR block with per-octet range validation (0–255). */
export const IpCidrSchema = z
  .string()
  .regex(new RegExp(`^(${OCTET}\\.){3}${OCTET}${PREFIX}$`), 'Invalid CIDR or IPv4 address');

const UpdateSchema = z
  .object({
    ipAllowlist: z.array(IpCidrSchema).max(32).optional(),
    rateLimitPerMin: z.number().int().min(1).max(10_000).optional(),
    /** Bind the key to an organization, or `null` to unbind (back to a single
     *  session). When set, the send path asks the router to pick a live,
     *  healthy, in-budget number instead of using the key's bound session. */
    orgId: OrgIdSchema.nullable().optional(),
  })
  .refine(
    (d) => d.ipAllowlist !== undefined || d.rateLimitPerMin !== undefined || d.orgId !== undefined,
    { message: 'Provide at least one field to update' },
  );

export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = mintRequestId(req.headers.get('x-request-id'));
  const guard = await requireAdmin({ webauthn: true });
  if (!guard.ok)
    return errorResponse(guard.status, ErrorCodes.UNAUTHORIZED, guard.message, requestId);
  const { id } = await ctx.params;
  const ok = await revokeKey(id);
  if (!ok)
    return errorResponse(
      404,
      ErrorCodes.INVALID_BODY,
      'Key not found or already revoked',
      requestId,
    );
  await appendAudit({
    actor: { kind: 'admin', id: guard.admin.email, email: guard.admin.email },
    action: 'api_key.revoke',
    target: { kind: 'api_key', id },
  });
  return jsonResponse(200, { revoked: true }, requestId);
}

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = mintRequestId(req.headers.get('x-request-id'));
  const guard = await requireAdmin({ webauthn: true });
  if (!guard.ok)
    return errorResponse(guard.status, ErrorCodes.UNAUTHORIZED, guard.message, requestId);

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return errorResponse(400, ErrorCodes.INVALID_BODY, 'Invalid JSON', requestId);
  }
  const parsed = UpdateSchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(400, ErrorCodes.INVALID_BODY, parsed.error.message, requestId);
  }

  const { id } = await ctx.params;
  const ok = await updateKey(id, parsed.data);
  if (!ok)
    return errorResponse(404, ErrorCodes.INVALID_BODY, 'Key not found or revoked', requestId);

  const patched = Object.keys(parsed.data);
  await appendAudit({
    actor: { kind: 'admin', id: guard.admin.email, email: guard.admin.email },
    action: 'api_key.update',
    target: { kind: 'api_key', id },
    meta: { patched },
  });
  return jsonResponse(200, { updated: true, patched }, requestId);
}

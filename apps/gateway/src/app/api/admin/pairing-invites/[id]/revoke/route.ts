/**
 * POST /api/admin/pairing-invites/:id/revoke, revoke a pending pairing
 * invite. `requireAdmin` only (no WebAuthn step-up), revoke only ever
 * reduces risk, the same posture as `webhook-routes.ts`'s revoke.
 */
import 'server-only';
import { requireAdmin } from '@/lib/require-admin';
import { errorResponse, jsonResponse } from '@/lib/http';
import { ErrorCodes } from '@hmddevs/protocol';
import { mintRequestId } from '@/lib/request-id';
import { findInviteById, revokeInvite } from '@/lib/repositories/pairing-invites';
import { appendAudit } from '@/lib/repositories/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = mintRequestId(req.headers.get('x-request-id'));
  const guard = await requireAdmin();
  if (!guard.ok)
    return errorResponse(guard.status, ErrorCodes.UNAUTHORIZED, guard.message, requestId);

  const { id } = await params;
  const invite = await findInviteById(id);
  if (!invite) return errorResponse(404, ErrorCodes.NOT_FOUND, 'Invite not found', requestId);

  const revoked = await revokeInvite(id);
  if (!revoked) {
    return errorResponse(
      409,
      ErrorCodes.IDEMPOTENCY_CONFLICT,
      'Link is no longer active',
      requestId,
    );
  }

  await appendAudit({
    actor: { kind: 'admin', id: guard.admin.email, email: guard.admin.email },
    action: 'pairing_invite.revoke',
    target: { kind: 'pairing_invite', id },
    meta: { orgId: invite.orgId, sessionIds: invite.sessionIds },
  }).catch(() => {});

  return jsonResponse(200, { ok: true }, requestId);
}

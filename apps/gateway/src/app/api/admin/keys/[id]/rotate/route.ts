/**
 * POST /api/admin/keys/:id/rotate, issue new secret bytes for an existing key.
 *
 * Patches `keyLookupHash` and `keyHash` only; the public `keyId` handle is
 * preserved so audit references and dashboards stay stable. The previous
 * secret stops authenticating immediately (the DB write commits before the
 * response is sent). Plaintext is returned ONCE, never stored plain.
 *
 * Requires WebAuthn step-up.
 */
import 'server-only';
import { requireAdmin } from '@/lib/require-admin';
import { errorResponse, jsonResponse } from '@/lib/http';
import { ErrorCodes } from '@hmddevs/protocol';
import { findById, rotateKey } from '@/lib/repositories/api-keys';
import { appendAudit } from '@/lib/repositories/audit';
import { mintRequestId } from '@/lib/request-id';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = mintRequestId(req.headers.get('x-request-id'));
  const guard = await requireAdmin({ webauthn: true });
  if (!guard.ok)
    return errorResponse(guard.status, ErrorCodes.UNAUTHORIZED, guard.message, requestId);

  const { id } = await ctx.params;
  const rotated = await rotateKey(id);
  if (!rotated)
    return errorResponse(404, ErrorCodes.INVALID_BODY, 'Key not found or revoked', requestId);

  // Reload the doc post-rotation to surface label/scopes/etc. in the response.
  const doc = await findById(rotated.keyId);
  if (!doc) {
    // Should not happen, rotateKey just matched the row.
    return errorResponse(404, ErrorCodes.INVALID_BODY, 'Key vanished after rotation', requestId);
  }

  await appendAudit({
    actor: { kind: 'admin', id: guard.admin.email, email: guard.admin.email },
    action: 'api_key.rotate',
    target: { kind: 'api_key', id: rotated.keyId },
  });

  return jsonResponse(
    200,
    {
      keyId: rotated.keyId,
      plaintext: rotated.plaintext, // ONCE, never stored plain
      label: doc.label,
      scopes: doc.scopes,
      env: doc.env,
      division: doc.division,
      sessionId: doc.sessionId,
    },
    requestId,
  );
}

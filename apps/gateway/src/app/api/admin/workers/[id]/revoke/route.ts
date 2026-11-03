/**
 * POST /api/admin/workers/:id/revoke
 *
 * Revoke a worker's current token by bumping its `tokenGen`. The worker's live
 * refresh token then has `gen < tokenGen`, so it is rejected on the wire within
 * the cache TTL (and on its next /v1/worker/refresh), forcing a re-bootstrap.
 *
 * Destructive to an active worker's auth, requires WebAuthn step-up, the same
 * guard as the DELETE handler.
 */
import 'server-only';
import { ErrorCodes } from '@hmddevs/protocol';
import { errorResponse, jsonResponse } from '@/lib/http';
import { mintRequestId } from '@/lib/request-id';
import { requireAdmin } from '@/lib/require-admin';
import { getWorker, upsertWorker } from '@/lib/repositories/worker-state';
import { appendAudit } from '@/lib/repositories/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = mintRequestId(req.headers.get('x-request-id'));
  const guard = await requireAdmin({ webauthn: true });
  if (!guard.ok) {
    return errorResponse(guard.status, ErrorCodes.UNAUTHORIZED, guard.message, requestId);
  }

  const { id } = await params;
  if (!id || id.length === 0) {
    return errorResponse(400, ErrorCodes.INVALID_BODY, 'Worker id is required', requestId);
  }

  const current = await getWorker(id);
  if (!current) {
    return errorResponse(404, ErrorCodes.INVALID_BODY, 'Worker not found', requestId);
  }

  // Bump the high-water generation. Every token issued so far has gen <= the
  // previous value, so all become strictly older than the new tokenGen and are
  // rejected. upsertWorker invalidates the cache write-through, so the wire
  // check sees the new gen within the TTL.
  const newGen = (current.tokenGen ?? 0) + 1;
  await upsertWorker(id, { tokenGen: newGen });

  await appendAudit({
    actor: { kind: 'admin', id: guard.admin.email, email: guard.admin.email },
    action: 'worker.token.revoke',
    target: { kind: 'worker', id },
    meta: { tokenGen: newGen },
  }).catch(() => {});

  return jsonResponse(200, { ok: true, workerId: id, tokenGen: newGen }, requestId);
}

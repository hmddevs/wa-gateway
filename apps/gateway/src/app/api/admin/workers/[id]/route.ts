/**
 * DELETE /api/admin/workers/:id
 *
 * SOFT-deletes a worker_state row (hides it from the admin UI) while preserving
 * and advancing its `tokenGen` high-water, so a deleted worker's tokens stay
 * revoked rather than being resurrected by a row that read back as gen 0. Used
 * to clean up ghost workers left behind after re-bootstrapping under a new
 * workerId (e.g. an old `m1-main` replaced by `primary` after a hardware wipe).
 *
 * Destructive, requires WebAuthn step-up. See `deleteWorker` for why it is soft.
 */
import 'server-only';
import { ErrorCodes } from '@hmddevs/protocol';
import { errorResponse, jsonResponse } from '@/lib/http';
import { mintRequestId } from '@/lib/request-id';
import { requireAdmin } from '@/lib/require-admin';
import { deleteWorker } from '@/lib/repositories/worker-state';
import { appendAudit } from '@/lib/repositories/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function DELETE(
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

  const removed = await deleteWorker(id);

  await appendAudit({
    actor: { kind: 'admin', id: guard.admin.email, email: guard.admin.email },
    action: 'worker.delete',
    target: { kind: 'worker', id },
    meta: { removed },
  }).catch(() => {});

  if (!removed) {
    return errorResponse(404, ErrorCodes.INVALID_BODY, 'Worker not found', requestId);
  }

  return jsonResponse(200, { ok: true, workerId: id }, requestId);
}

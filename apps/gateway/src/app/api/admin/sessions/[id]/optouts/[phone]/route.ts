/**
 * Admin opt-out removal.
 * DELETE /api/admin/sessions/:id/optouts/:phone  → drop the entry
 *
 * The phone segment is URL-encoded (E.164 starts with `+`); we decode it
 * before lookup. 404 when no entry exists for (sessionId, phone).
 */
import 'server-only';
import { ErrorCodes } from '@hmddevs/protocol';
import { requireAdmin } from '@/lib/require-admin';
import { errorResponse } from '@/lib/http';
import { mintRequestId } from '@/lib/request-id';
import { removeOptOut } from '@/lib/repositories/optouts';
import { appendAudit } from '@/lib/repositories/audit';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const E164_RE = /^\+[1-9]\d{6,14}$/;

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string; phone: string }> },
): Promise<Response> {
  const requestId = mintRequestId(req.headers.get('x-request-id'));
  const guard = await requireAdmin();
  if (!guard.ok)
    return errorResponse(guard.status, ErrorCodes.UNAUTHORIZED, guard.message, requestId);

  const { id, phone: phoneRaw } = await params;
  const phone = decodeURIComponent(phoneRaw);
  if (!E164_RE.test(phone)) {
    return errorResponse(400, ErrorCodes.INVALID_PHONE, 'Phone must be E.164', requestId);
  }

  const removed = await removeOptOut(id, phone);
  if (!removed) {
    return errorResponse(404, ErrorCodes.RECIPIENT_NOT_FOUND, 'Opt-out not found', requestId);
  }

  await appendAudit({
    actor: { kind: 'admin', id: guard.admin.email, email: guard.admin.email },
    action: 'optout.remove',
    target: { kind: 'session', id },
    meta: { phone },
  }).catch((err) => logger.warn({ err: (err as Error).message }, 'audit append failed'));

  return new Response(null, { status: 204, headers: { 'X-Request-Id': requestId } });
}

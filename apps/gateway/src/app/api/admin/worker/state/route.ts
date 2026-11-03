/** GET /api/admin/worker/state, admin-only session snapshot across all sessions. */
import 'server-only';
import { requireAdmin } from '@/lib/require-admin';
import { errorResponse, jsonResponse } from '@/lib/http';
import { ErrorCodes } from '@hmddevs/protocol';
import { listSessions } from '@/lib/repositories/sessions';
import { mintRequestId } from '@/lib/request-id';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const requestId = mintRequestId(req.headers.get('x-request-id'));
  const guard = await requireAdmin();
  if (!guard.ok)
    return errorResponse(guard.status, ErrorCodes.UNAUTHORIZED, guard.message, requestId);
  const sessions = await listSessions();
  return jsonResponse(200, { sessions }, requestId);
}

/**
 * GET /api/admin/sessions/:id/metrics
 *
 * Returns 24-hour send/receive/webhook counts plus hourly sparklines for one
 * session. Results are cached in Redis for 30 s to absorb dashboard polling.
 * Auth: requireAdmin() only, read-only data, no WebAuthn step-up.
 */
import 'server-only';
import { ErrorCodes, SessionIdSchema } from '@hmddevs/protocol';
import { requireAdmin } from '@/lib/require-admin';
import { errorResponse, jsonResponse } from '@/lib/http';
import { mintRequestId } from '@/lib/request-id';
import { getSession } from '@/lib/repositories/sessions';
import { adminLimiterKey, checkAdminLimit } from '@/lib/admin-rate-limit';
import { getSessionMetrics } from '@/lib/repositories/metrics';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = mintRequestId(req.headers.get('x-request-id'));

  try {
    const guard = await requireAdmin();
    if (!guard.ok) {
      return errorResponse(guard.status, ErrorCodes.UNAUTHORIZED, guard.message, requestId);
    }

    const { id: rawId } = await ctx.params;
    const idParse = SessionIdSchema.safeParse(rawId);
    if (!idParse.success) {
      return errorResponse(400, ErrorCodes.INVALID_BODY, 'Invalid session id', requestId);
    }
    const id = idParse.data;

    const ok = await checkAdminLimit(adminLimiterKey(guard.admin));
    if (!ok) {
      return errorResponse(429, ErrorCodes.RATE_LIMITED, 'Too many admin requests', requestId);
    }

    const session = await getSession(id);
    if (!session) {
      return errorResponse(404, ErrorCodes.INVALID_BODY, 'Session not found', requestId);
    }

    const metrics = await getSessionMetrics(id, session.status ?? null);
    return jsonResponse(200, metrics, requestId);
  } catch (err: unknown) {
    logger.error(
      { err: (err as Error).message, requestId, op: 'admin.metrics' },
      'session metrics failed',
    );
    return errorResponse(500, ErrorCodes.INTERNAL, 'Internal error', requestId);
  }
}

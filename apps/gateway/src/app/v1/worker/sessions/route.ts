/**
 * GET /v1/worker/sessions, returns the sessions this worker should manage.
 * Called by the worker on boot to discover which Baileys sessions to start.
 * Authenticated via worker JWT (Bearer token).
 */
import 'server-only';
import { ErrorCodes } from '@hmddevs/protocol';
import { errorResponse, jsonResponse } from '@/lib/http';
import { mintRequestId } from '@/lib/request-id';
import { verifyWorkerJwt } from '@/lib/worker-jwt';
import { assertWorkerGenerationFresh, RevokedTokenError } from '@/lib/worker-auth';
import { listSessionsByWorker } from '@/lib/repositories/sessions';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const requestId = mintRequestId(req.headers.get('x-request-id'));
  const authz = req.headers.get('authorization');
  if (!authz?.startsWith('Bearer ')) {
    return errorResponse(401, ErrorCodes.UNAUTHORIZED, 'Missing worker token', requestId);
  }

  let claims;
  try {
    claims = await verifyWorkerJwt(authz.slice(7).trim());
  } catch {
    return errorResponse(401, ErrorCodes.UNAUTHORIZED, 'Invalid worker token', requestId);
  }
  // Bootstrap tokens are single-use refresh credentials only; they must never
  // authorise a wire operation (mirrors the callback route).
  if (claims.typ === 'bootstrap') {
    return errorResponse(401, ErrorCodes.UNAUTHORIZED, 'Bootstrap token not accepted', requestId);
  }
  // Reject a superseded (revoked/rotated) refresh token; fail open on infra error.
  try {
    await assertWorkerGenerationFresh(claims);
  } catch (err: unknown) {
    if (err instanceof RevokedTokenError) {
      logger.warn(
        { workerId: claims.workerId, requestId },
        'worker sessions list rejected: token revoked (stale generation)',
      );
      return errorResponse(401, ErrorCodes.UNAUTHORIZED, 'Worker token revoked', requestId);
    }
    logger.warn(
      { err: (err as Error).message, workerId: claims.workerId, requestId },
      'worker generation check failed; failing open',
    );
  }

  const docs = await listSessionsByWorker(claims.workerId);
  const sessions = docs
    .filter((s) => s.status !== 'stopped')
    .map((s) => ({ sessionId: s.sessionId, label: s.label }));

  return jsonResponse(200, { sessions }, requestId);
}

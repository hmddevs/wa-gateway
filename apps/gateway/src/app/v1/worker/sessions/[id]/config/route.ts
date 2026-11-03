/**
 * GET /v1/worker/sessions/:id/config
 *
 * Worker-only, returns the conversational config for a session so the worker
 * can apply behaviour toggles (e.g. send-read-receipts) at the Baileys layer.
 *
 * Auth mirrors the worker callback: a valid worker JWT (Authorization: Bearer)
 * scoped to the same `workerId` that owns the session. We refuse if the JWT's
 * subject doesn't match the session's `workerId`, prevents one worker from
 * polling configs for sessions it doesn't own.
 */
import 'server-only';
import { ErrorCodes } from '@hmddevs/protocol';
import { errorResponse, jsonResponse } from '@/lib/http';
import { mintRequestId } from '@/lib/request-id';
import { verifyWorkerJwt } from '@/lib/worker-jwt';
import { assertWorkerGenerationFresh, RevokedTokenError } from '@/lib/worker-auth';
import { getSession, getConversationConfig } from '@/lib/repositories/sessions';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
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
        'worker config read rejected: token revoked (stale generation)',
      );
      return errorResponse(401, ErrorCodes.UNAUTHORIZED, 'Worker token revoked', requestId);
    }
    logger.warn(
      { err: (err as Error).message, workerId: claims.workerId, requestId },
      'worker generation check failed; failing open',
    );
  }

  const { id } = await params;
  const session = await getSession(id);
  if (!session) {
    return errorResponse(404, ErrorCodes.INVALID_BODY, 'Session not found', requestId);
  }
  if (session.workerId !== claims.workerId) {
    return errorResponse(
      403,
      ErrorCodes.SCOPE_DENIED,
      'Worker is not bound to this session',
      requestId,
    );
  }

  const cfg = (await getConversationConfig(id)) ?? {
    sendReadReceipts: true,
    syncFullHistory: false,
  };
  return jsonResponse(
    200,
    {
      sendReadReceipts: cfg.sendReadReceipts,
      syncFullHistory: cfg.syncFullHistory ?? false,
    },
    requestId,
  );
}

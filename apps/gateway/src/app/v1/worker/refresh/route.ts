/**
 * POST /v1/worker/refresh
 *
 * Worker presents a current JWT (bootstrap or refresh). Gateway mints a
 * new refresh token with gen+1 and returns it. Old tokens remain valid
 * until their exp (can't revoke stateless JWTs cheaply), this is
 * acceptable because the gateway tracks the current generation in
 * worker_state and rejects stale generations on wire-level operations.
 */
import 'server-only';
import { errorResponse, jsonResponse } from '@/lib/http';
import { ErrorCodes } from '@hmddevs/protocol';
import { issueRefreshToken, verifyWorkerJwt } from '@/lib/worker-jwt';
import { consumeBootstrapJti } from '@/lib/wire';
import { upsertWorker, getWorker } from '@/lib/repositories/worker-state';
import { appendAudit } from '@/lib/repositories/audit';
import { mintRequestId } from '@/lib/request-id';
import { env } from '@/lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
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

  // Bootstrap tokens are single-use: consume the JTI atomically; reject replays.
  if (claims.typ === 'bootstrap') {
    const first = await consumeBootstrapJti(claims.jti);
    if (!first) {
      return errorResponse(401, ErrorCodes.UNAUTHORIZED, 'Bootstrap token already used', requestId);
    }
  }

  const state = await getWorker(claims.workerId);
  const currentGen = state?.tokenGen ?? 0;

  // If presenting a refresh token whose gen is stale, reject.
  if (claims.typ === 'refresh' && typeof claims.gen === 'number' && claims.gen < currentGen) {
    return errorResponse(401, ErrorCodes.UNAUTHORIZED, 'Stale generation', requestId);
  }

  const newGen = Math.max(currentGen, claims.gen ?? 0) + 1;
  const { token, jti } = await issueRefreshToken({
    workerId: claims.workerId,
    generation: newGen,
  });

  await upsertWorker(claims.workerId, { tokenGen: newGen });

  await appendAudit({
    actor: { kind: 'system', id: 'worker', email: undefined },
    action: 'worker.token.refresh',
    target: { kind: 'worker', id: claims.workerId },
    meta: { gen: newGen, jti },
  }).catch(() => {});

  if (claims.typ === 'bootstrap') {
    return jsonResponse(
      200,
      {
        refreshToken: token,
        generation: newGen,
        wireSecretB64: env.WORKER_WIRE_SECRET,
        upstashRedisUrl: env.UPSTASH_REDIS_URL,
      },
      requestId,
    );
  }

  return jsonResponse(200, { refreshToken: token, generation: newGen }, requestId);
}

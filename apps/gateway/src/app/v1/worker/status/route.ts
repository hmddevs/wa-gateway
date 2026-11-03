/**
 * GET /v1/worker/status, current worker / session health.
 *
 * Any authenticated API key with `read:status` may call this. When the
 * caller's API key is bound to a session, the response reflects THAT
 * session's status (per-session granularity). Legacy keys without a
 * `sessionId` fall back to the bare `WORKER_ID` worker-state row, which
 * preserves the original behaviour.
 *
 * Response shape adds a `sessionId` field but keeps `workerId` for
 * backwards compatibility.
 */
import 'server-only';
import { authenticate, requireScope } from '@/lib/auth-api';
import { errorResponse, jsonResponse } from '@/lib/http';
import { ErrorCodes } from '@hmddevs/protocol';
import { env } from '@/lib/env';
import { getWorker } from '@/lib/repositories/worker-state';
import { getSession } from '@/lib/repositories/sessions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STALE_HEARTBEAT_MS = 60_000;

export async function GET(req: Request): Promise<Response> {
  const auth = await authenticate(req);
  if (!auth.ok) return auth.response;
  if (!requireScope(auth.apiKey, 'read:status')) {
    return errorResponse(
      403,
      ErrorCodes.SCOPE_DENIED,
      'Missing scope: read:status',
      auth.requestId,
    );
  }

  const sessionId = auth.apiKey.sessionId;
  const now = Date.now();

  if (sessionId) {
    const session = await getSession(sessionId);
    const heartbeatAge = session?.lastHeartbeatAt ? now - session.lastHeartbeatAt.getTime() : null;
    const effective = !session
      ? 'offline'
      : heartbeatAge === null || heartbeatAge > STALE_HEARTBEAT_MS
        ? 'offline'
        : session.status;

    // queueDepth is currently a worker-level metric; surface it from the
    // worker row when the session resolves to one.
    const worker = session ? await getWorker(session.workerId) : null;

    return jsonResponse(
      200,
      {
        workerId: session?.workerId ?? env.WORKER_ID,
        sessionId,
        status: effective,
        lastHeartbeatAt: session?.lastHeartbeatAt ?? null,
        connectedAt: session?.connectedAt ?? null,
        phoneE164: session?.phoneE164 ?? null,
        version: session?.version ?? null,
        queueDepth: worker?.queueDepth ?? null,
      },
      auth.requestId,
    );
  }

  // Legacy path, no sessionId on the key.
  const doc = await getWorker(env.WORKER_ID);
  const heartbeatAge = doc?.lastHeartbeatAt ? now - doc.lastHeartbeatAt.getTime() : null;
  const effective = !doc
    ? 'offline'
    : heartbeatAge === null || heartbeatAge > STALE_HEARTBEAT_MS
      ? 'offline'
      : doc.status;

  return jsonResponse(
    200,
    {
      workerId: env.WORKER_ID,
      status: effective,
      lastHeartbeatAt: doc?.lastHeartbeatAt ?? null,
      connectedAt: doc?.connectedAt ?? null,
      phoneE164: doc?.phoneE164 ?? null,
      version: doc?.version ?? null,
      queueDepth: doc?.queueDepth ?? null,
    },
    auth.requestId,
  );
}

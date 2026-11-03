/** POST /api/admin/worker/bootstrap, admin-scoped proxy that issues a bootstrap JWT. */
import 'server-only';
import { requireAdmin } from '@/lib/require-admin';
import { errorResponse, jsonResponse } from '@/lib/http';
import { ErrorCodes } from '@hmddevs/protocol';
import { issueBootstrapToken } from '@/lib/worker-jwt';
import { appendAudit } from '@/lib/repositories/audit';
import { mintRequestId } from '@/lib/request-id';
import { env } from '@/lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  const requestId = mintRequestId(req.headers.get('x-request-id'));
  const guard = await requireAdmin({ webauthn: true });
  if (!guard.ok)
    return errorResponse(guard.status, ErrorCodes.UNAUTHORIZED, guard.message, requestId);
  const { token, jti } = await issueBootstrapToken({
    workerId: env.WORKER_ID,
    createdBy: guard.admin.email,
  });
  await appendAudit({
    actor: { kind: 'admin', id: guard.admin.email, email: guard.admin.email },
    action: 'worker.bootstrap.issue',
    target: { kind: 'worker', id: env.WORKER_ID },
    meta: { jti },
  });
  return jsonResponse(200, { bootstrapToken: token, workerId: env.WORKER_ID }, requestId);
}

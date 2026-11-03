/**
 * POST /v1/worker/bootstrap
 *
 * Admin-only (WebAuthn step-up required). Issues a 15-minute one-shot
 * JWT the worker uses to obtain a long-lived refresh token during
 * first-run install.
 */
import 'server-only';
import { z } from 'zod';
import { requireAdmin } from '@/lib/require-admin';
import { errorResponse, jsonResponse } from '@/lib/http';
import { ErrorCodes } from '@hmddevs/protocol';
import { issueBootstrapToken } from '@/lib/worker-jwt';
import { appendAudit } from '@/lib/repositories/audit';
import { mintRequestId } from '@/lib/request-id';
import { env } from '@/lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BodySchema = z.object({ workerId: z.string().min(1).default('primary') });

export async function POST(req: Request): Promise<Response> {
  const requestId = mintRequestId(req.headers.get('x-request-id'));
  const guard = await requireAdmin({ webauthn: true });
  if (!guard.ok)
    return errorResponse(guard.status, ErrorCodes.UNAUTHORIZED, guard.message, requestId);

  let raw: unknown = {};
  try {
    raw = await req.json();
  } catch {
    /* empty body allowed */
  }
  const parsed = BodySchema.safeParse(raw);
  const workerId = parsed.success ? parsed.data.workerId : env.WORKER_ID;

  const { token, jti } = await issueBootstrapToken({
    workerId,
    createdBy: guard.admin.email,
  });

  await appendAudit({
    actor: { kind: 'admin', id: guard.admin.email, email: guard.admin.email },
    action: 'worker.bootstrap.issue',
    target: { kind: 'worker', id: workerId },
    meta: { jti },
  });

  return jsonResponse(200, { refreshToken: token, workerId }, requestId);
}

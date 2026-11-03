/**
 * POST /api/admin/sessions/:id/control, send a control command to a session.
 * Requires WebAuthn step-up.
 */
import 'server-only';
import { z } from 'zod';
import { requireAdmin } from '@/lib/require-admin';
import { errorResponse, jsonResponse } from '@/lib/http';
import { ErrorCodes } from '@hmddevs/protocol';
import { mintRequestId } from '@/lib/request-id';
import { getSession, invalidateSessionCache } from '@/lib/repositories/sessions';
import { appendAudit } from '@/lib/repositories/audit';
import { getRedis } from '@/lib/redis';
import { channels, sign, newNonce, nowIso } from '@/lib/wire';
import { env } from '@/lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ControlSchema = z.object({
  action: z.enum(['restart', 'reset_session', 'logout', 'start_session']),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = mintRequestId(req.headers.get('x-request-id'));
  const guard = await requireAdmin({ webauthn: true });
  if (!guard.ok)
    return errorResponse(guard.status, ErrorCodes.UNAUTHORIZED, guard.message, requestId);

  const { id } = await params;
  const session = await getSession(id);
  if (!session) return errorResponse(404, ErrorCodes.INVALID_BODY, 'Session not found', requestId);

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return errorResponse(400, ErrorCodes.INVALID_BODY, 'Invalid JSON', requestId);
  }

  const parsed = ControlSchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(400, ErrorCodes.INVALID_BODY, parsed.error.message, requestId);
  }

  const { action } = parsed.data;
  const workerId = session.workerId ?? env.WORKER_ID;

  const envelope = await sign({
    type: 'control' as const,
    action,
    sessionId: id,
    nonce: newNonce(),
    at: nowIso(),
    sig: '',
  });
  const redis = getRedis();
  await redis.publish(channels.control(workerId), JSON.stringify(envelope));

  // Invalidate cache after publishing control command (fire-and-forget).
  invalidateSessionCache(id).catch(() => {});

  await appendAudit({
    actor: { kind: 'admin', id: guard.admin.email, email: guard.admin.email },
    action: `session.control.${action}`,
    target: { kind: 'session', id },
    meta: { workerId },
  }).catch(() => {});

  return jsonResponse(200, { ok: true }, requestId);
}

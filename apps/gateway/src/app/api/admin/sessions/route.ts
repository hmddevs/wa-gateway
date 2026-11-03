/**
 * Admin session management.
 * GET  /api/admin/sessions, list all sessions
 * POST /api/admin/sessions, create a new session and signal the worker
 *
 * POST requires WebAuthn step-up; GET does not.
 */
import 'server-only';
import { z } from 'zod';
import { requireAdmin } from '@/lib/require-admin';
import { errorResponse, jsonResponse } from '@/lib/http';
import { ErrorCodes } from '@hmddevs/protocol';
import { mintRequestId } from '@/lib/request-id';
import { listSessions } from '@/lib/repositories/sessions';
import { createSessionAndStartPairing } from '@/lib/session-provisioning';
import { env } from '@/lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CreateSchema = z.object({
  sessionId: z
    .string()
    .regex(/^[a-z0-9-]{2,32}$/, 'Must be 2-32 lowercase alphanumeric/hyphen chars'),
  label: z.string().min(1).max(128),
  workerId: z.string().min(1).optional(),
});

export async function GET(req: Request): Promise<Response> {
  const requestId = mintRequestId(req.headers.get('x-request-id'));
  const guard = await requireAdmin();
  if (!guard.ok)
    return errorResponse(guard.status, ErrorCodes.UNAUTHORIZED, guard.message, requestId);
  const sessions = await listSessions();
  return jsonResponse(200, { sessions }, requestId);
}

export async function POST(req: Request): Promise<Response> {
  const requestId = mintRequestId(req.headers.get('x-request-id'));
  const guard = await requireAdmin({ webauthn: true });
  if (!guard.ok)
    return errorResponse(guard.status, ErrorCodes.UNAUTHORIZED, guard.message, requestId);

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return errorResponse(400, ErrorCodes.INVALID_BODY, 'Invalid JSON', requestId);
  }

  const parsed = CreateSchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(400, ErrorCodes.INVALID_BODY, parsed.error.message, requestId);
  }

  const { sessionId, label } = parsed.data;
  const workerId = parsed.data.workerId ?? env.WORKER_ID;

  const session = await createSessionAndStartPairing({
    sessionId,
    label,
    workerId,
    createdBy: guard.admin.email,
    auditAction: 'session.create',
  });

  return jsonResponse(201, { session }, requestId);
}

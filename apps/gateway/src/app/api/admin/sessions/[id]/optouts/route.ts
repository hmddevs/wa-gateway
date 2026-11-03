/**
 * Admin opt-out registry.
 * GET    /api/admin/sessions/:id/optouts  → list session's opt-outs
 * POST   /api/admin/sessions/:id/optouts  → manual add (admin source)
 *
 * Removal is via the sibling [phone]/route.ts.
 */
import 'server-only';
import { z } from 'zod';
import { ErrorCodes } from '@hmddevs/protocol';
import { requireAdmin } from '@/lib/require-admin';
import { errorResponse, jsonResponse } from '@/lib/http';
import { mintRequestId } from '@/lib/request-id';
import { addOptOut, listOptOuts } from '@/lib/repositories/optouts';
import { getSession } from '@/lib/repositories/sessions';
import { appendAudit } from '@/lib/repositories/audit';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const E164_RE = /^\+[1-9]\d{6,14}$/;

const PostSchema = z.object({
  phone: z.string().trim().regex(E164_RE, 'Must be E.164 (e.g. +447700900123)'),
});

const MAX_BODY_BYTES = 4 * 1024;

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = mintRequestId(req.headers.get('x-request-id'));
  const guard = await requireAdmin();
  if (!guard.ok)
    return errorResponse(guard.status, ErrorCodes.UNAUTHORIZED, guard.message, requestId);

  const { id } = await params;
  const session = await getSession(id);
  if (!session) {
    return errorResponse(404, ErrorCodes.INVALID_BODY, 'Session not found', requestId);
  }

  const optOuts = await listOptOuts(id);
  return jsonResponse(200, { optOuts }, requestId);
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = mintRequestId(req.headers.get('x-request-id'));
  const guard = await requireAdmin();
  if (!guard.ok)
    return errorResponse(guard.status, ErrorCodes.UNAUTHORIZED, guard.message, requestId);

  const len = Number(req.headers.get('content-length') ?? 0);
  if (len > MAX_BODY_BYTES) {
    return errorResponse(413, ErrorCodes.PAYLOAD_TOO_LARGE, 'Body too large', requestId);
  }

  const { id } = await params;
  const session = await getSession(id);
  if (!session) {
    return errorResponse(404, ErrorCodes.INVALID_BODY, 'Session not found', requestId);
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return errorResponse(400, ErrorCodes.INVALID_BODY, 'Invalid JSON', requestId);
  }
  const parsed = PostSchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(400, ErrorCodes.INVALID_BODY, parsed.error.message, requestId);
  }

  try {
    await addOptOut(id, parsed.data.phone, 'admin');
  } catch (err: unknown) {
    logger.error({ err: (err as Error).message, sessionId: id }, 'optout add failed');
    return errorResponse(500, ErrorCodes.INTERNAL, 'Failed to add opt-out', requestId);
  }

  await appendAudit({
    actor: { kind: 'admin', id: guard.admin.email, email: guard.admin.email },
    action: 'optout.add',
    target: { kind: 'session', id },
    meta: { phone: parsed.data.phone, source: 'admin' },
  }).catch((err) => logger.warn({ err: (err as Error).message }, 'audit append failed'));

  return jsonResponse(201, { phone: parsed.data.phone, source: 'admin' }, requestId);
}

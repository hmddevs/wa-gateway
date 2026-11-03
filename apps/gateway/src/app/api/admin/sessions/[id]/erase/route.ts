/**
 * POST /api/admin/sessions/:id/erase, data-subject erasure (right to be
 * forgotten). Hard-deletes every stored trace of a recipient on this session.
 *
 * WebAuthn step-up required. Opt-out suppression is deliberately retained, see
 * lib/repositories/erasure.ts.
 */
import 'server-only';
import { z } from 'zod';
import { ErrorCodes } from '@hmddevs/protocol';
import { requireAdmin } from '@/lib/require-admin';
import { errorResponse, jsonResponse } from '@/lib/http';
import { mintRequestId } from '@/lib/request-id';
import { getSession } from '@/lib/repositories/sessions';
import { eraseContact } from '@/lib/repositories/erasure';
import { appendAudit } from '@/lib/repositories/audit';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 4 * 1024;
const E164_RE = /^\+\d{7,15}$/;

const BodySchema = z.object({
  phone: z.string().regex(E164_RE, 'Must be E.164 (e.g. +447700900123)'),
  confirm: z.literal(true, {
    error: () => 'Set confirm:true to proceed with erasure',
  }),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = mintRequestId(req.headers.get('x-request-id'));
  const guard = await requireAdmin({ webauthn: true });
  if (!guard.ok)
    return errorResponse(guard.status, ErrorCodes.UNAUTHORIZED, guard.message, requestId);

  const len = Number(req.headers.get('content-length') ?? 0);
  if (len > MAX_BODY_BYTES) {
    return errorResponse(413, ErrorCodes.PAYLOAD_TOO_LARGE, 'Body too large', requestId);
  }

  const { id } = await params;
  const session = await getSession(id);
  if (!session) return errorResponse(404, ErrorCodes.INVALID_BODY, 'Session not found', requestId);

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return errorResponse(400, ErrorCodes.INVALID_BODY, 'Invalid JSON', requestId);
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(400, ErrorCodes.INVALID_BODY, parsed.error.message, requestId);
  }
  const { phone } = parsed.data;

  let erased;
  try {
    erased = await eraseContact(id, phone);
  } catch (err: unknown) {
    logger.error({ err: (err as Error).message, sessionId: id }, 'contact erasure failed');
    return errorResponse(500, ErrorCodes.INTERNAL, 'Failed to erase contact', requestId);
  }

  await appendAudit({
    actor: { kind: 'admin', id: guard.admin.email, email: guard.admin.email },
    action: 'contact.erased',
    target: { kind: 'session', id },
    meta: { phone, ...erased },
  }).catch((err) => logger.warn({ err: (err as Error).message }, 'audit append failed'));

  return jsonResponse(200, { ok: true, phone, erased }, requestId);
}

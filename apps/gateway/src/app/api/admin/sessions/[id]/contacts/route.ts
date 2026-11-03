/**
 * Admin contacts viewer, list chat contacts for one session.
 * GET /api/admin/sessions/:id/contacts
 *
 * Auth: `requireAdmin()` only (read-only; no WebAuthn step-up).
 * Per-admin-session rate limit applied on top of the global IP limiter.
 *
 * Powers display-name resolution in the conversations panel so peer JIDs
 * render with `pushName` / `notify` / `verifiedName` instead of raw E.164.
 */
import 'server-only';
import { ErrorCodes, SessionIdSchema } from '@hmddevs/protocol';
import { requireAdmin } from '@/lib/require-admin';
import { errorResponse, jsonResponse } from '@/lib/http';
import { mintRequestId } from '@/lib/request-id';
import { getSession } from '@/lib/repositories/sessions';
// why: read from the new `contacts` collection (slice 1 schema, populated by
// the worker's `kind: 'contact'` events). The legacy `chat_contacts` repo is
// still consumed by the older threads aggregation; this route is the
// authoritative contact-book read for the WhatsApp-Web admin viewer.
import { listContactsForSession } from '@/lib/repositories/contacts';
import { adminLimiterKey, checkAdminLimit } from '@/lib/admin-rate-limit';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = mintRequestId(req.headers.get('x-request-id'));

  try {
    const guard = await requireAdmin();
    if (!guard.ok) {
      return errorResponse(guard.status, ErrorCodes.UNAUTHORIZED, guard.message, requestId);
    }

    const { id: rawId } = await ctx.params;
    const idParse = SessionIdSchema.safeParse(rawId);
    if (!idParse.success) {
      return errorResponse(400, ErrorCodes.INVALID_BODY, 'Invalid session id', requestId);
    }
    const id = idParse.data;

    const ok = await checkAdminLimit(adminLimiterKey(guard.admin));
    if (!ok) {
      return errorResponse(429, ErrorCodes.RATE_LIMITED, 'Too many admin requests', requestId);
    }

    const session = await getSession(id);
    if (!session) {
      return errorResponse(404, ErrorCodes.INVALID_BODY, 'Session not found', requestId);
    }

    const contacts = await listContactsForSession(id);

    return jsonResponse(200, { contacts }, requestId);
  } catch (err: unknown) {
    logger.error(
      { err: (err as Error).message, requestId, op: 'admin.contacts.list' },
      'admin contacts list failed',
    );
    return errorResponse(500, ErrorCodes.INTERNAL, 'Internal error', requestId);
  }
}

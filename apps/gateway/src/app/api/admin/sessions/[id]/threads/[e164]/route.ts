/**
 * Admin conversation viewer, list messages for one (session, counterparty) thread.
 * GET /api/admin/sessions/:id/threads/:e164
 *
 * Auth: `requireAdmin()` only (read-only slice; no WebAuthn step-up).
 * Returns newest-first; UI reverses for chronological display.
 */
import 'server-only';
import { E164Schema, ErrorCodes, SessionIdSchema } from '@hmddevs/protocol';
import type { AdminThreadMessage } from '@hmddevs/protocol';
import { requireAdmin } from '@/lib/require-admin';
import { errorResponse, jsonResponse } from '@/lib/http';
import { mintRequestId } from '@/lib/request-id';
import { getSession } from '@/lib/repositories/sessions';
import { listThreadMessages } from '@/lib/repositories/messages';
import { decodeAdminThreadCursor, encodeAdminThreadCursor } from '@/lib/cursors';
import { adminLimiterKey, checkAdminLimit } from '@/lib/admin-rate-limit';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MIN_LIMIT = 1;

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string; e164: string }> },
): Promise<Response> {
  const requestId = mintRequestId(req.headers.get('x-request-id'));

  try {
    const guard = await requireAdmin();
    if (!guard.ok) {
      return errorResponse(guard.status, ErrorCodes.UNAUTHORIZED, guard.message, requestId);
    }

    const { id: rawId, e164: rawE164 } = await ctx.params;
    const idParse = SessionIdSchema.safeParse(rawId);
    if (!idParse.success) {
      return errorResponse(400, ErrorCodes.INVALID_BODY, 'Invalid session id', requestId);
    }
    const id = idParse.data;

    const e164Parse = E164Schema.safeParse(rawE164);
    if (!e164Parse.success) {
      return errorResponse(400, ErrorCodes.INVALID_BODY, 'Invalid counterparty E.164', requestId);
    }
    const counterparty = e164Parse.data;

    const ok = await checkAdminLimit(adminLimiterKey(guard.admin));
    if (!ok) {
      return errorResponse(429, ErrorCodes.RATE_LIMITED, 'Too many admin requests', requestId);
    }

    const session = await getSession(id);
    if (!session) {
      return errorResponse(404, ErrorCodes.INVALID_BODY, 'Session not found', requestId);
    }

    const url = new URL(req.url);
    const cursorParam = url.searchParams.get('cursor');
    const limitParam = url.searchParams.get('limit');

    let limit = DEFAULT_LIMIT;
    if (limitParam !== null) {
      const n = Number.parseInt(limitParam, 10);
      if (!Number.isFinite(n)) {
        return errorResponse(400, ErrorCodes.INVALID_BODY, 'Invalid limit', requestId);
      }
      limit = Math.min(Math.max(n, MIN_LIMIT), MAX_LIMIT);
    }

    let cursor: { ts: Date; id: string } | null = null;
    if (cursorParam) {
      cursor = decodeAdminThreadCursor(cursorParam);
      if (!cursor) {
        return errorResponse(400, ErrorCodes.INVALID_BODY, 'Invalid cursor', requestId);
      }
    }

    const result = await listThreadMessages(id, counterparty, { cursor, limit });

    const items: AdminThreadMessage[] = result.items.map((row) => ({
      messageId: row.messageId,
      direction: row.direction,
      ts: row.ts.toISOString(),
      body: row.body,
      ...(row.status ? { status: row.status } : {}),
      ...(row.revisions && row.revisions.length > 0
        ? { revisions: row.revisions as AdminThreadMessage['revisions'] }
        : {}),
      ...(row.latestBody ? { latestBody: row.latestBody } : {}),
      ...(row.editedAt ? { editedAt: row.editedAt } : {}),
      ...(row.deletedAt ? { deletedAt: row.deletedAt } : {}),
      ...(row.replyTo ? { replyTo: row.replyTo } : {}),
      ...(row.reactions && row.reactions.length > 0 ? { reactions: row.reactions } : {}),
    }));

    const nextCursor = result.nextCursor ? encodeAdminThreadCursor(result.nextCursor) : null;

    return jsonResponse(200, { items, nextCursor }, requestId);
  } catch (err: unknown) {
    logger.error(
      { err: (err as Error).message, requestId, op: 'admin.threads.messages' },
      'admin thread messages failed',
    );
    return errorResponse(500, ErrorCodes.INTERNAL, 'Internal error', requestId);
  }
}

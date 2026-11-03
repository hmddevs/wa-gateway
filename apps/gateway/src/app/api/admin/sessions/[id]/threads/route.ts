/**
 * Admin conversation viewer, list threads for one session.
 * GET /api/admin/sessions/:id/threads
 *
 * Auth: `requireAdmin()` only (read-only slice; no WebAuthn step-up).
 * Per-admin-session rate limit applied on top of the global IP limiter.
 */
import 'server-only';
import { ErrorCodes, SessionIdSchema } from '@hmddevs/protocol';
import type { AdminThreadSummary } from '@hmddevs/protocol';
import { requireAdmin } from '@/lib/require-admin';
import { errorResponse, jsonResponse } from '@/lib/http';
import { mintRequestId } from '@/lib/request-id';
import { getSession } from '@/lib/repositories/sessions';
import { listThreadsForSession } from '@/lib/repositories/messages';
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

    const url = new URL(req.url);
    const cursorParam = url.searchParams.get('cursor');
    const searchParam = url.searchParams.get('search');
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

    const result = await listThreadsForSession(id, {
      cursor,
      search: searchParam ?? undefined,
      limit,
    });

    const items: AdminThreadSummary[] = result.items.map((row) => ({
      counterparty: row.counterparty,
      // why: existing test fixtures (and pre-group rows) omit `type`; default
      // to `'dm'` so JSON shape stays stable for DM consumers and groups
      // surface as `'group'`. `counterpartyJid` is conditionally spread so DM
      // payloads stay key-clean.
      type: row.type ?? 'dm',
      ...(row.counterpartyJid ? { counterpartyJid: row.counterpartyJid } : {}),
      lastMessageAt: row.lastMessageAt.toISOString(),
      lastMessagePreview: row.lastMessagePreview,
      lastMessageDirection: row.lastMessageDirection,
      ...(row.lastMessageStatus ? { lastMessageStatus: row.lastMessageStatus } : {}),
      unreadCount: row.unreadCount,
    }));

    const nextCursor = result.nextCursor ? encodeAdminThreadCursor(result.nextCursor) : null;

    return jsonResponse(200, { items, nextCursor }, requestId);
  } catch (err: unknown) {
    logger.error(
      { err: (err as Error).message, requestId, op: 'admin.threads.list' },
      'admin threads list failed',
    );
    return errorResponse(500, ErrorCodes.INTERNAL, 'Internal error', requestId);
  }
}

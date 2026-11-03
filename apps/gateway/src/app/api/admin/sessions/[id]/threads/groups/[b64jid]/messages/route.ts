/**
 * Admin conversation viewer, list messages for one (session, group JID) thread.
 * GET /api/admin/sessions/:id/threads/groups/:b64jid/messages
 *
 * `:b64jid` is the WhatsApp group JID (e.g. `120363xxxxxxxxxxx@g.us`) encoded
 * as base64url. Groups never have an E.164 form, so we cannot reuse the DM
 * `[e164]` route, and we don't want raw `@` characters in the path.
 *
 * Auth: `requireAdmin()` only (read-only slice; matches DM messages route).
 * Per-admin-session rate limit applied on top of the global IP limiter.
 */
import 'server-only';
import { ErrorCodes, SessionIdSchema } from '@hmddevs/protocol';
import type { AdminThreadMessage } from '@hmddevs/protocol';
import { requireAdmin } from '@/lib/require-admin';
import { errorResponse, jsonResponse } from '@/lib/http';
import { mintRequestId } from '@/lib/request-id';
import { getSession } from '@/lib/repositories/sessions';
import { listGroupMessages } from '@/lib/repositories/messages';
import { decodeAdminThreadCursor, encodeAdminThreadCursor } from '@/lib/cursors';
import { adminLimiterKey, checkAdminLimit } from '@/lib/admin-rate-limit';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MIN_LIMIT = 1;
const GROUP_JID_SUFFIX = '@g.us';
/** Hard cap on decoded JID length, real WhatsApp group JIDs are <40 chars. */
const MAX_JID_LEN = 128;

function decodeGroupJid(b64: string): string | null {
  try {
    // Next.js decodes path params before our handler, but be defensive in case
    // a caller double-encodes, `decodeURIComponent` on already-decoded text
    // is a no-op for safe characters.
    const raw = Buffer.from(decodeURIComponent(b64), 'base64url').toString('utf8');
    if (raw.length === 0 || raw.length > MAX_JID_LEN) return null;
    if (!raw.endsWith(GROUP_JID_SUFFIX)) return null;
    // Whitelist a conservative JID character set. Modern group JIDs are
    // `<digits>@g.us`; legacy ones use `<digits>-<digits>@g.us`. Allowing
    // alphanumerics + `._-` covers both without giving Mongo anything weird.
    if (!/^[A-Za-z0-9._-]+@g\.us$/.test(raw)) return null;
    return raw;
  } catch {
    return null;
  }
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string; b64jid: string }> },
): Promise<Response> {
  const requestId = mintRequestId(req.headers.get('x-request-id'));

  try {
    const guard = await requireAdmin();
    if (!guard.ok) {
      return errorResponse(guard.status, ErrorCodes.UNAUTHORIZED, guard.message, requestId);
    }

    const { id: rawId, b64jid: rawB64 } = await ctx.params;
    const idParse = SessionIdSchema.safeParse(rawId);
    if (!idParse.success) {
      return errorResponse(400, ErrorCodes.INVALID_BODY, 'Invalid session id', requestId);
    }
    const id = idParse.data;

    const counterpartyJid = decodeGroupJid(rawB64);
    if (!counterpartyJid) {
      return errorResponse(400, ErrorCodes.INVALID_BODY, 'invalid group id', requestId);
    }

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

    const result = await listGroupMessages(id, counterpartyJid, { cursor, limit });

    const items: AdminThreadMessage[] = result.items.map((row) => ({
      messageId: row.messageId,
      direction: row.direction,
      ts: row.ts.toISOString(),
      body: row.body,
      // why: groups have no per-message status, `chat_events` rows are
      // observational. Omit the field entirely so the schema's `.optional()`
      // path drops it from JSON.
    }));

    const nextCursor = result.nextCursor ? encodeAdminThreadCursor(result.nextCursor) : null;

    return jsonResponse(200, { items, nextCursor }, requestId);
  } catch (err: unknown) {
    logger.error(
      { err: (err as Error).message, requestId, op: 'admin.threads.groupMessages' },
      'admin group messages failed',
    );
    return errorResponse(500, ErrorCodes.INTERNAL, 'Internal error', requestId);
  }
}

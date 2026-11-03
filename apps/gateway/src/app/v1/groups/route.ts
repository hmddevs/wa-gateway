/**
 * GET /v1/groups, discover the WhatsApp group JIDs the calling API key's
 * bound session belongs to, so a group JID can be passed as `to` on
 * `POST /v1/messages`.
 *
 * - Bearer API key, rate-limited (see `authenticate`).
 * - Requires the `read:groups` scope.
 * - Strictly scoped to `apiKey.sessionId`, see `listSessionGroups` for the
 *   tenant-isolation query.
 */
import 'server-only';
import { ErrorCodes } from '@hmddevs/protocol';
import type { ListGroupsResponse } from '@hmddevs/protocol';
import { authenticate, requireScope } from '@/lib/auth-api';
import { errorResponse, jsonResponse } from '@/lib/http';
import { listSessionGroups } from '@/lib/repositories/chat-events';
import { findGroupsByJids } from '@/lib/repositories/groups';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const auth = await authenticate(req);
  if (!auth.ok) return auth.response;
  const { apiKey, requestId } = auth;

  if (!requireScope(apiKey, 'read:groups')) {
    return errorResponse(403, ErrorCodes.SCOPE_DENIED, 'Missing scope: read:groups', requestId);
  }

  try {
    // `apiKey.sessionId` only, never a caller-supplied value, is the
    // tenant-isolation boundary. A key can only ever see its own session's
    // groups.
    const rows = await listSessionGroups(apiKey.sessionId);
    // Single extra query (no N+1): fetch stored metadata for exactly the
    // JIDs the activity aggregation returned, then join in memory. A group
    // with chat activity but no captured metadata still gets a row, the
    // activity aggregation stays the sole source of which groups are
    // listed; metadata is purely additive.
    const metadataByJid = await findGroupsByJids(
      apiKey.sessionId,
      rows.map((r) => r.jid),
    );
    const body: ListGroupsResponse = {
      groups: rows.map((r) => {
        const meta = metadataByJid.get(r.jid);
        return {
          jid: r.jid,
          lastActivityAt: r.lastActivityAt.toISOString(),
          ...(meta?.subject !== undefined ? { subject: meta.subject } : {}),
          ...(meta?.subjectOwner !== undefined ? { subjectOwner: meta.subjectOwner } : {}),
          ...(meta?.subjectTime !== undefined ? { subjectTime: meta.subjectTime } : {}),
          ...(meta?.creation !== undefined ? { creation: meta.creation } : {}),
          ...(meta?.owner !== undefined ? { owner: meta.owner } : {}),
          ...(meta?.desc !== undefined ? { desc: meta.desc } : {}),
          ...(meta?.descId !== undefined ? { descId: meta.descId } : {}),
          ...(meta?.announce !== undefined ? { announce: meta.announce } : {}),
          ...(meta?.restrict !== undefined ? { restrict: meta.restrict } : {}),
          ...(meta?.size !== undefined ? { size: meta.size } : {}),
          ...(meta?.ephemeralDuration !== undefined
            ? { ephemeralDuration: meta.ephemeralDuration }
            : {}),
          ...(meta?.inviteCode !== undefined ? { inviteCode: meta.inviteCode } : {}),
          ...(meta?.participants !== undefined ? { participants: meta.participants } : {}),
          ...(meta?.fetchedAt !== undefined ? { metadataFetchedAt: meta.fetchedAt } : {}),
        };
      }),
    };
    return jsonResponse(200, body, requestId);
  } catch (err: unknown) {
    logger.error(
      { err: (err as Error).message, requestId, op: 'v1.groups.list' },
      'group listing failed',
    );
    return errorResponse(500, ErrorCodes.INTERNAL, 'Internal error', requestId);
  }
}

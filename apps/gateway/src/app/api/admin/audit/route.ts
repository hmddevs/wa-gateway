import 'server-only';
import { requireAdmin } from '@/lib/require-admin';
import { errorResponse, jsonResponse } from '@/lib/http';
import { ErrorCodes } from '@hmddevs/protocol';
import { mintRequestId } from '@/lib/request-id';
import { listAudit, type AuditEntryDoc } from '@/lib/repositories/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const requestId = mintRequestId(req.headers.get('x-request-id'));

  const guard = await requireAdmin();
  if (!guard.ok) {
    return errorResponse(guard.status, ErrorCodes.UNAUTHORIZED, guard.message, requestId);
  }

  const url = new URL(req.url);
  const rawBefore = url.searchParams.get('before');
  const rawLimit = url.searchParams.get('limit');
  const action = url.searchParams.get('action') ?? undefined;

  const before = rawBefore ? parseInt(rawBefore, 10) : undefined;
  if (before !== undefined && !Number.isFinite(before)) {
    return errorResponse(400, ErrorCodes.INVALID_BODY, 'Invalid before cursor', requestId);
  }

  let limit = 50;
  if (rawLimit !== null) {
    const parsedLimit = parseInt(rawLimit, 10);
    if (!Number.isFinite(parsedLimit) || parsedLimit < 1) {
      return errorResponse(400, ErrorCodes.INVALID_BODY, 'Invalid limit', requestId);
    }
    limit = Math.min(parsedLimit, 200);
  }

  const entries = await listAudit({ before, limit, actionPrefix: action });

  const serialised = entries.map((e: AuditEntryDoc) => ({
    ...e,
    at: e.at instanceof Date ? e.at.toISOString() : e.at,
  }));

  const nextBefore = entries.length === limit ? entries[entries.length - 1]!.seq : null;

  return jsonResponse(200, { entries: serialised, nextBefore }, requestId);
}

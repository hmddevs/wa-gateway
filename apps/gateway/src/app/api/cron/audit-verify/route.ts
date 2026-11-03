/**
 * Cron: verify the audit hash chain. Alerts on break via log.
 *
 * Thin HTTP wrapper over `runAuditVerify()` (see `@/lib/jobs/audit-verify`).
 */
import 'server-only';
import { isCronAuthorized } from '@/lib/cron-auth';
import { runAuditVerify } from '@/lib/jobs/audit-verify';
import { mintRequestId } from '@/lib/request-id';
import { errorResponse, jsonResponse } from '@/lib/http';
import { ErrorCodes } from '@hmddevs/protocol';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  // When the in-process scheduler owns the jobs (long-running deployment), this public HTTP
  // trigger is dead surface, return 404 so it cannot be hit at all. With the
  // flag off (Vercel-style), the route stays live for Vercel cron to drive.
  if (process.env.SCHEDULER_ENABLED === '1') {
    return new Response('Not found', { status: 404 });
  }
  const requestId = mintRequestId(req.headers.get('x-request-id'));
  if (!isCronAuthorized(req)) {
    return errorResponse(401, ErrorCodes.UNAUTHORIZED, 'Cron unauthorized', requestId);
  }
  const result = await runAuditVerify();
  return jsonResponse(200, result, requestId);
}

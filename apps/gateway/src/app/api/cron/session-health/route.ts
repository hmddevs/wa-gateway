/**
 * Cron: session-disconnect alarm.
 *
 * Thin HTTP wrapper over `checkSessionHealth()` (see `@/lib/jobs/session-health`).
 * The job body is shared with the in-process scheduler; this route exists for
 * manual triggering and a `?selftest=1` alert-pipeline check. It returns 404
 * when the in-process scheduler owns the jobs (long-running deployment), mirroring the reap route.
 */
import 'server-only';
import { isCronAuthorized } from '@/lib/cron-auth';
import { checkSessionHealth } from '@/lib/jobs/session-health';
import { mintRequestId } from '@/lib/request-id';
import { errorResponse, jsonResponse } from '@/lib/http';
import { sendAlertEmail } from '@/lib/email';
import { logger } from '@/lib/logger';
import { ErrorCodes } from '@hmddevs/protocol';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  // When the in-process scheduler owns the jobs (long-running deployment), this public HTTP
  // trigger is dead surface, return 404 so it cannot be hit at all.
  if (process.env.SCHEDULER_ENABLED === '1') {
    return new Response('Not found', { status: 404 });
  }
  const requestId = mintRequestId(req.headers.get('x-request-id'));
  if (!isCronAuthorized(req)) {
    return errorResponse(401, ErrorCodes.UNAUTHORIZED, 'Cron unauthorized', requestId);
  }

  // On-demand verification of the alert email pipeline.
  if (new URL(req.url).searchParams.get('selftest') === '1') {
    try {
      await sendAlertEmail({
        subject: 'wa-gateway: session-health alert pipeline self-test',
        text:
          'This is a self-test of the gateway session-health alert pipeline. ' +
          'If you received this, session-disconnect alerts are delivering.\n\n' +
          `requestId: ${requestId}`,
      });
      return jsonResponse(200, { selftest: 'sent' }, requestId);
    } catch (err) {
      logger.error({ err: (err as Error).message, requestId }, 'session-health self-test failed');
      return errorResponse(
        500,
        ErrorCodes.INTERNAL,
        `Alert self-test failed: ${(err as Error).message}`,
        requestId,
      );
    }
  }

  const result = await checkSessionHealth();
  return jsonResponse(
    200,
    { checked: result.checked, alerted: result.alerted, recovered: result.recovered },
    requestId,
  );
}

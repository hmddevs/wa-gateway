/**
 * Cron: expire messages whose TTL has elapsed and re-publish any messages
 * still in `queued` for more than 30 seconds (worker likely restarted).
 *
 * Thin HTTP wrapper over `runReap()` (see `@/lib/jobs/reap`). The job body is
 * shared with the in-process scheduler; this route preserves the original
 * auth + response contract plus the `?selftest=1` alert-pipeline check.
 */
import 'server-only';
import { isCronAuthorized } from '@/lib/cron-auth';
import { runReap } from '@/lib/jobs/reap';
import { mintRequestId } from '@/lib/request-id';
import { errorResponse, jsonResponse } from '@/lib/http';
import { sendAlertEmail } from '@/lib/email';
import { logger } from '@/lib/logger';
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

  // On-demand verification of the alert email pipeline. Authorised callers can
  // hit `?selftest=1` to send one test alert through the exact sendAlertEmail
  // path and surface any Resend error, rather than waiting for a real incident.
  if (new URL(req.url).searchParams.get('selftest') === '1') {
    try {
      await sendAlertEmail({
        subject: 'wa-gateway: alert pipeline self-test',
        text:
          'This is a self-test of the gateway alert email pipeline. ' +
          'If you received this, operational alerts are delivering.\n\n' +
          `requestId: ${requestId}`,
      });
      return jsonResponse(200, { selftest: 'sent' }, requestId);
    } catch (err) {
      logger.error({ err: (err as Error).message, requestId }, 'alert pipeline self-test failed');
      return errorResponse(
        500,
        ErrorCodes.INTERNAL,
        `Alert self-test failed: ${(err as Error).message}`,
        requestId,
      );
    }
  }

  const result = await runReap(requestId);
  return jsonResponse(
    200,
    { expired: result.expired, stalled: result.stalled, alerted: result.alerted },
    requestId,
  );
}

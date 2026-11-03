/**
 * Cron: webhook delivery sweep.
 *
 * Thin HTTP wrapper over `runWebhookDeliver()` (see `@/lib/jobs/webhook-deliver`).
 * The job body is shared with the in-process scheduler; this route preserves
 * the original auth + response contract.
 *
 * Scheduled every minute. Vercel Pro supports unlimited crons, so a finer
 * grain is possible if delivery latency proves to be a pain point.
 */
import 'server-only';
import { ErrorCodes } from '@hmddevs/protocol';
import { errorResponse, jsonResponse } from '@/lib/http';
import { mintRequestId } from '@/lib/request-id';
import { isCronAuthorized } from '@/lib/cron-auth';
import { runWebhookDeliver } from '@/lib/jobs/webhook-deliver';

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

  const { ok: _ok, ...summary } = await runWebhookDeliver();
  return jsonResponse(200, summary, requestId);
}

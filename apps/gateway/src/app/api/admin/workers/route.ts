/**
 * GET /api/admin/workers
 *
 * Returns the list of workers the gateway has heard from, derived from
 * `worker_state`. Drives the worker dropdown in the create-session dialog
 * so admins pick from a list of real workers instead of typing a workerId
 * by hand (eliminates a class of typo bugs and surfaces health at choice
 * time).
 *
 * Each entry carries an inferred `online` flag using the same 60s
 * heartbeat-staleness threshold the watchdog cron applies before flipping
 * a session to `offline`. Callers should treat `online: false` as
 * "probably can't pair right now" without removing the worker from the
 * list, an admin may legitimately want to provision into a worker that
 * hasn't started yet.
 */
import 'server-only';
import { ErrorCodes } from '@hmddevs/protocol';
import { errorResponse, jsonResponse } from '@/lib/http';
import { mintRequestId } from '@/lib/request-id';
import { requireAdmin } from '@/lib/require-admin';
import { listAllWorkers } from '@/lib/repositories/worker-state';
import { env } from '@/lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STALE_AFTER_MS = 60_000;

interface AdminWorkerView {
  workerId: string;
  status: 'offline' | 'pairing' | 'connected' | 'degraded';
  online: boolean;
  lastHeartbeatAt: string | null;
  connectedAt: string | null;
  deviceName: string | null;
  hostname: string | null;
  version: string | null;
  phoneE164: string | null;
  queueDepth: number | null;
  lastError: { code: string; detail: string; at: string } | null;
}

export async function GET(req: Request): Promise<Response> {
  const requestId = mintRequestId(req.headers.get('x-request-id'));
  const guard = await requireAdmin();
  if (!guard.ok) {
    return errorResponse(guard.status, ErrorCodes.UNAUTHORIZED, guard.message, requestId);
  }

  const docs = await listAllWorkers();
  const now = Date.now();

  // Always include the env-default workerId in the response so a freshly-
  // installed worker that hasn't sent its first heartbeat yet still appears
  // in the dropdown. Without this, admins would be unable to create the
  // first-ever session on a brand-new install.
  const seen = new Set(docs.map((d) => d.workerId));
  const workers: AdminWorkerView[] = docs.map((d) => {
    const ageMs = d.lastHeartbeatAt ? now - new Date(d.lastHeartbeatAt).getTime() : Infinity;
    return {
      workerId: d.workerId,
      status: d.status,
      online: ageMs <= STALE_AFTER_MS && d.status !== 'offline',
      lastHeartbeatAt: d.lastHeartbeatAt ? new Date(d.lastHeartbeatAt).toISOString() : null,
      connectedAt: d.connectedAt ? new Date(d.connectedAt).toISOString() : null,
      deviceName: d.deviceName ?? null,
      hostname: d.hostname ?? null,
      version: d.version ?? null,
      phoneE164: d.phoneE164 ?? null,
      queueDepth: d.queueDepth ?? null,
      lastError: d.lastError
        ? {
            code: d.lastError.code,
            detail: d.lastError.detail,
            at: new Date(d.lastError.at).toISOString(),
          }
        : null,
    };
  });

  if (!seen.has(env.WORKER_ID)) {
    workers.push({
      workerId: env.WORKER_ID,
      status: 'offline',
      online: false,
      lastHeartbeatAt: null,
      connectedAt: null,
      deviceName: null,
      hostname: null,
      version: null,
      phoneE164: null,
      queueDepth: null,
      lastError: null,
    });
  }

  return jsonResponse(200, { workers }, requestId);
}

/**
 * GET /api/admin/system/health
 *
 * Server-side aggregate for the System health view. Returns:
 *   - workers: online/offline breakdown (from worker_state)
 *   - totalQueueDepth: sum of queueDepth across all workers
 *   - recentErrors: lastError from each worker that has one
 *   - send24h: total sent/failed across all sessions for 24 h error-rate
 *
 * Read-only. No WebAuthn step-up required. Avoids N per-session client calls
 * (each session would need its own metrics fetch) by aggregating server-side
 * in a single pass over worker_state + a lightweight message aggregate.
 */
import 'server-only';
import { ErrorCodes } from '@hmddevs/protocol';
import { errorResponse, jsonResponse } from '@/lib/http';
import { mintRequestId } from '@/lib/request-id';
import { requireAdmin } from '@/lib/require-admin';
import { listAllWorkers } from '@/lib/repositories/worker-state';
import { col } from '@/lib/mongo';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STALE_AFTER_MS = 60_000;

export interface SystemHealthResponse {
  workers: {
    total: number;
    online: number;
    offline: number;
  };
  totalQueueDepth: number;
  recentErrors: Array<{
    workerId: string;
    code: string;
    detail: string;
    at: string;
  }>;
  send24h: {
    sent: number;
    failed: number;
  };
}

interface MessageCountRow {
  status: string;
  count: number;
}

export async function GET(req: Request): Promise<Response> {
  const requestId = mintRequestId(req.headers.get('x-request-id'));

  try {
    const guard = await requireAdmin();
    if (!guard.ok) {
      return errorResponse(guard.status, ErrorCodes.UNAUTHORIZED, guard.message, requestId);
    }

    const [workers, msgRows] = await Promise.all([
      listAllWorkers(),
      // 24 h outbound message counts, only status-level group, not sparklines.
      (async () => {
        const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const c = await col<{ status: string }>('messages');
        return c
          .aggregate<MessageCountRow>([
            {
              $match: { direction: { $in: ['out_api', 'out_device'] }, createdAt: { $gte: since } },
            },
            { $group: { _id: '$status', count: { $sum: 1 } } },
            { $project: { _id: 0, status: '$_id', count: 1 } },
          ])
          .toArray();
      })(),
    ]);

    const now = Date.now();
    let online = 0;
    let offline = 0;
    let totalQueueDepth = 0;
    const recentErrors: SystemHealthResponse['recentErrors'] = [];

    for (const w of workers) {
      const ageMs = w.lastHeartbeatAt ? now - new Date(w.lastHeartbeatAt).getTime() : Infinity;
      const isOnline = ageMs <= STALE_AFTER_MS && w.status !== 'offline';
      if (isOnline) {
        online += 1;
      } else {
        offline += 1;
      }
      if (typeof w.queueDepth === 'number') {
        totalQueueDepth += w.queueDepth;
      }
      if (w.lastError) {
        recentErrors.push({
          workerId: w.workerId,
          code: w.lastError.code,
          detail: w.lastError.detail,
          at: new Date(w.lastError.at).toISOString(),
        });
      }
    }

    // Sort most recent errors first.
    recentErrors.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

    let sent = 0;
    let failed = 0;
    for (const row of msgRows) {
      if (row.status === 'failed' || row.status === 'expired') {
        failed += row.count;
      } else {
        sent += row.count;
      }
    }

    const body: SystemHealthResponse = {
      workers: { total: workers.length, online, offline },
      totalQueueDepth,
      recentErrors,
      send24h: { sent, failed },
    };

    return jsonResponse(200, body, requestId);
  } catch (err: unknown) {
    logger.error(
      { err: (err as Error).message, requestId, op: 'admin.system.health' },
      'system health fetch failed',
    );
    return errorResponse(500, ErrorCodes.INTERNAL, 'Internal error', requestId);
  }
}

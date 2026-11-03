/**
 * GET /api/admin/system/health, route handler tests.
 *
 * Mocked boundaries:
 *   - @/lib/require-admin
 *   - @/lib/repositories/worker-state, listAllWorkers
 *   - @/lib/mongo, col
 *   - @/lib/logger, logger
 *   - @/lib/request-id, mintRequestId
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- module mocks -----------------------------------------------------------

vi.mock('@/lib/require-admin', () => ({
  requireAdmin: vi.fn(),
}));

vi.mock('@/lib/repositories/worker-state', () => ({
  listAllWorkers: vi.fn(),
}));

vi.mock('@/lib/mongo', () => ({
  col: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/request-id', () => ({
  mintRequestId: vi.fn(() => 'req-test'),
}));

// ---- imports after mocks ----------------------------------------------------

import { GET } from '../route';
import { requireAdmin } from '@/lib/require-admin';
import { listAllWorkers } from '@/lib/repositories/worker-state';
import { col } from '@/lib/mongo';
import type { WorkerStateDoc } from '@/lib/repositories/worker-state';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockRequireAdmin = requireAdmin as ReturnType<typeof vi.fn>;
const mockListAllWorkers = listAllWorkers as ReturnType<typeof vi.fn>;
const mockCol = col as ReturnType<typeof vi.fn>;

function makeAdminContext() {
  return {
    ok: true as const,
    admin: { email: 'admin@test.com', sessionId: null, webauthnFreshAt: null },
  };
}

function makeWorker(overrides: Partial<WorkerStateDoc> = {}): WorkerStateDoc {
  return {
    workerId: 'primary',
    status: 'connected',
    lastHeartbeatAt: new Date(),
    queueDepth: 0,
    lastError: null,
    ...overrides,
  };
}

function makeReq() {
  return new Request('http://localhost/api/admin/system/health');
}

function makeAggregateMock(rows: Array<{ status: string; count: number }>) {
  return {
    aggregate: vi.fn().mockReturnValue({ toArray: vi.fn().mockResolvedValue(rows) }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/admin/system/health', () => {
  it('returns 401 when not authenticated', async () => {
    mockRequireAdmin.mockResolvedValueOnce({ ok: false, status: 401, message: 'Unauthorised' });

    const res = await GET(makeReq());
    expect(res.status).toBe(401);
  });

  it('returns correct worker counts and zero queue depth for a single online worker', async () => {
    mockRequireAdmin.mockResolvedValueOnce(makeAdminContext());
    mockListAllWorkers.mockResolvedValueOnce([
      makeWorker({ workerId: 'primary', status: 'connected', queueDepth: 0 }),
    ]);
    mockCol.mockResolvedValueOnce(makeAggregateMock([]));

    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      workers: { total: number; online: number; offline: number };
      totalQueueDepth: number;
      recentErrors: unknown[];
      send24h: { sent: number; failed: number };
    };
    expect(body.workers.total).toBe(1);
    expect(body.workers.online).toBe(1);
    expect(body.workers.offline).toBe(0);
    expect(body.totalQueueDepth).toBe(0);
    expect(body.recentErrors).toHaveLength(0);
  });

  it('marks a worker offline when heartbeat is stale (>60 s)', async () => {
    mockRequireAdmin.mockResolvedValueOnce(makeAdminContext());
    const staleAt = new Date(Date.now() - 90_000); // 90 s ago
    mockListAllWorkers.mockResolvedValueOnce([
      makeWorker({ status: 'connected', lastHeartbeatAt: staleAt }),
    ]);
    mockCol.mockResolvedValueOnce(makeAggregateMock([]));

    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      workers: { online: number; offline: number };
    };
    expect(body.workers.online).toBe(0);
    expect(body.workers.offline).toBe(1);
  });

  it('sums queue depth across multiple workers', async () => {
    mockRequireAdmin.mockResolvedValueOnce(makeAdminContext());
    mockListAllWorkers.mockResolvedValueOnce([
      makeWorker({ workerId: 'w1', queueDepth: 3 }),
      makeWorker({ workerId: 'w2', queueDepth: 7 }),
    ]);
    mockCol.mockResolvedValueOnce(makeAggregateMock([]));

    const res = await GET(makeReq());
    const body = (await res.json()) as { totalQueueDepth: number };
    expect(body.totalQueueDepth).toBe(10);
  });

  it('surfaces recentErrors from workers that have a lastError', async () => {
    mockRequireAdmin.mockResolvedValueOnce(makeAdminContext());
    mockListAllWorkers.mockResolvedValueOnce([
      makeWorker({
        workerId: 'w1',
        lastError: { code: 'SEND_FAIL', detail: 'socket closed', at: new Date() },
      }),
    ]);
    mockCol.mockResolvedValueOnce(makeAggregateMock([]));

    const res = await GET(makeReq());
    const body = (await res.json()) as { recentErrors: Array<{ code: string }> };
    expect(body.recentErrors).toHaveLength(1);
    expect(body.recentErrors[0]?.code).toBe('SEND_FAIL');
  });

  it('computes send24h correctly from message aggregate rows', async () => {
    mockRequireAdmin.mockResolvedValueOnce(makeAdminContext());
    mockListAllWorkers.mockResolvedValueOnce([makeWorker()]);
    mockCol.mockResolvedValueOnce(
      makeAggregateMock([
        { status: 'sent', count: 50 },
        { status: 'delivered', count: 20 },
        { status: 'failed', count: 5 },
        { status: 'expired', count: 2 },
      ]),
    );

    const res = await GET(makeReq());
    const body = (await res.json()) as { send24h: { sent: number; failed: number } };
    // sent + delivered = 70; failed + expired = 7
    expect(body.send24h.sent).toBe(70);
    expect(body.send24h.failed).toBe(7);
  });

  it('returns 500 when listAllWorkers throws', async () => {
    mockRequireAdmin.mockResolvedValueOnce(makeAdminContext());
    mockListAllWorkers.mockRejectedValueOnce(new Error('DB error'));
    mockCol.mockResolvedValueOnce(makeAggregateMock([]));

    const res = await GET(makeReq());
    expect(res.status).toBe(500);
  });
});

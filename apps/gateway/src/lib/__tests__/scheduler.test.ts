/**
 * scheduler.ts, lock-behaviour unit tests.
 *
 * Mocks the Redis client and every job body. Drives a single job tick via
 * the public timer path (`startScheduler` + fake timers).
 *
 * SCHEDULER_DISTRIBUTED_LOCKS default (unset/'0'): single-instance
 * assumption, only the in-process `running` mutex guards a tick, and an
 * idle tick must issue zero Redis commands.
 *
 * SCHEDULER_DISTRIBUTED_LOCKS='1': restores the Redis `SET NX PX` / `DEL`
 * cross-replica lock, asserted here exactly as before this change:
 *   - when the Redis lock is NOT acquired, the job body is never called;
 *   - when the lock IS acquired, the body runs and the lock is released;
 *   - `startScheduler()` is idempotent (no double-registration of timers).
 *
 * The `server-only` guard is neutralised by the vitest.config.ts alias.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---- module mocks ---------------------------------------------------------
// Hoisted so the vi.mock factories (themselves hoisted to top of file) can
// reference these stubs without a temporal-dead-zone error.
const {
  redisSet,
  redisDel,
  runScheduledDispatch,
  runWebhookDeliver,
  runReap,
  runAuditVerify,
  checkSessionHealth,
  checkAuthFailures,
  envState,
} = vi.hoisted(() => ({
  redisSet: vi.fn(),
  redisDel: vi.fn(),
  runScheduledDispatch: vi.fn(),
  runWebhookDeliver: vi.fn(),
  runReap: vi.fn(),
  runAuditVerify: vi.fn(),
  checkSessionHealth: vi.fn(),
  checkAuthFailures: vi.fn(),
  // Mutable so individual tests can flip SCHEDULER_DISTRIBUTED_LOCKS.
  envState: { SCHEDULER_DISTRIBUTED_LOCKS: '0' as '0' | '1' },
}));

vi.mock('@/lib/redis', () => ({
  getRedis: () => ({ set: redisSet, del: redisDel }),
}));

vi.mock('@/lib/env', () => ({ env: envState }));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/jobs/scheduled-dispatch', () => ({ runScheduledDispatch }));
vi.mock('@/lib/jobs/webhook-deliver', () => ({ runWebhookDeliver }));
vi.mock('@/lib/jobs/reap', () => ({ runReap }));
vi.mock('@/lib/jobs/audit-verify', () => ({ runAuditVerify }));
vi.mock('@/lib/jobs/session-health', () => ({ checkSessionHealth }));
vi.mock('@/lib/jobs/auth-failure-alarm', () => ({ checkAuthFailures }));

// ---- imports after mocks --------------------------------------------------
import { startScheduler, stopScheduler, __schedulerJobs } from '@/lib/scheduler';

const DISPATCH_INTERVAL = __schedulerJobs.find((j) => j.name === 'scheduled-dispatch')!.intervalMs;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  envState.SCHEDULER_DISTRIBUTED_LOCKS = '0';
  runScheduledDispatch.mockResolvedValue({ ok: true, counts: {} });
  runWebhookDeliver.mockResolvedValue({ ok: true, counts: {} });
  runReap.mockResolvedValue({ ok: true, counts: {} });
  runAuditVerify.mockResolvedValue({ ok: true, counts: {} });
  checkSessionHealth.mockResolvedValue({ ok: true, checked: 0, alerted: 0, recovered: 0 });
});

afterEach(() => {
  stopScheduler();
  vi.useRealTimers();
});

/** Advance to the first scheduled-dispatch tick and flush its async chain. */
async function fireDispatchTick(): Promise<void> {
  await vi.advanceTimersByTimeAsync(DISPATCH_INTERVAL);
}

describe('scheduler, default (SCHEDULER_DISTRIBUTED_LOCKS unset): single-instance, in-process mutex only', () => {
  it('runs the job body on an idle tick without issuing any Redis command', async () => {
    startScheduler();
    await fireDispatchTick();

    expect(runScheduledDispatch).toHaveBeenCalledOnce();
    expect(redisSet).not.toHaveBeenCalled();
    expect(redisDel).not.toHaveBeenCalled();
  });

  it('the in-process mutex still prevents a slow run from overlapping itself', async () => {
    // Simulate a slow run still in flight, then resolve it before the test
    // ends, the `running` map is module-level state shared across tests in
    // this file, so a permanently-hanging promise here would leak into and
    // break every test that runs afterwards.
    let resolveSlowRun!: () => void;
    runScheduledDispatch.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveSlowRun = resolve;
      }),
    );

    startScheduler();
    await fireDispatchTick(); // starts the slow run
    await fireDispatchTick(); // second tick while the first is still in flight

    expect(runScheduledDispatch).toHaveBeenCalledOnce();
    resolveSlowRun();
    // Flush the `finally` that clears the in-process mutex so the next test
    // in this file starts from a clean `running` map.
    await vi.advanceTimersByTimeAsync(0);
  });
});

describe('scheduler, SCHEDULER_DISTRIBUTED_LOCKS=1: Redis lock held elsewhere', () => {
  it('does NOT call the job body when SET NX returns null', async () => {
    envState.SCHEDULER_DISTRIBUTED_LOCKS = '1';
    // ioredis returns null when the NX key already exists.
    redisSet.mockResolvedValue(null);

    startScheduler();
    await fireDispatchTick();

    expect(redisSet).toHaveBeenCalledWith(
      'wa:lock:job:scheduled-dispatch',
      'locked',
      'PX',
      expect.any(Number),
      'NX',
    );
    expect(runScheduledDispatch).not.toHaveBeenCalled();
    // No body ran, so nothing to release.
    expect(redisDel).not.toHaveBeenCalled();
  });
});

describe('scheduler, SCHEDULER_DISTRIBUTED_LOCKS=1: Redis lock acquired', () => {
  it('runs the job body and releases the lock', async () => {
    envState.SCHEDULER_DISTRIBUTED_LOCKS = '1';
    redisSet.mockResolvedValue('OK');
    redisDel.mockResolvedValue(1);

    startScheduler();
    await fireDispatchTick();

    expect(runScheduledDispatch).toHaveBeenCalledOnce();
    expect(redisDel).toHaveBeenCalledWith('wa:lock:job:scheduled-dispatch');
  });
});

describe('scheduler, SCHEDULER_DISTRIBUTED_LOCKS=1: concurrent ticks are serialised by the lock', () => {
  it('only one of two contending ticks runs the body', async () => {
    envState.SCHEDULER_DISTRIBUTED_LOCKS = '1';
    // First contender gets the lock; the simulated second replica is denied.
    // We model contention by having SET return OK once then null.
    redisSet.mockResolvedValueOnce('OK').mockResolvedValue(null);
    redisDel.mockResolvedValue(1);

    startScheduler();
    await fireDispatchTick(); // OK -> runs
    await fireDispatchTick(); // null -> no-op

    expect(runScheduledDispatch).toHaveBeenCalledOnce();
  });
});

describe('scheduler, startScheduler is idempotent', () => {
  it('does not double-register timers on a second start call', async () => {
    startScheduler();
    startScheduler(); // second call must be a no-op

    await fireDispatchTick();

    // A double registration would fire the body twice per interval.
    expect(runScheduledDispatch).toHaveBeenCalledOnce();
  });
});

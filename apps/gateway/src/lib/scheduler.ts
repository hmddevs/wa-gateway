/**
 * In-process job scheduler.
 *
 * Replaces the Vercel cron jobs with `setInterval` timers for the long-running
 * self-hosted deployment. Each registered job runs the shared `runX()` body from
 * `@/lib/jobs/*` on a fixed cadence, guarded by up to two independent locks:
 *
 *   1. An in-process boolean mutex per job so a slow run never overlaps itself
 *      within the same process. Always on.
 *   2. A Redis lock `wa:lock:job:<name>` taken with `SET NX PX` so that, across
 *      replicas (or overlapping ticks), only one runner executes a given job at
 *      a time. Mirrors the `SET NX EX` nonce pattern in `@/lib/wire`. OPT-IN
 *      via `SCHEDULER_DISTRIBUTED_LOCKS=1` (see the flag read below), the
 *      gateway runs as exactly one instance, so the in-process mutex alone
 *      is sufficient today and this lock costs two Redis commands per job per
 *      tick for no benefit. Flip the flag back on before ever scaling the
 *      gateway to more than one instance.
 *
 * The scheduler is feature-flagged OFF by default (`SCHEDULER_ENABLED`) and is
 * started from `instrumentation.ts` on the Node runtime only.
 */
import 'server-only';
import { getRedis } from '@/lib/redis';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { runScheduledDispatch } from '@/lib/jobs/scheduled-dispatch';
import { runWebhookDeliver } from '@/lib/jobs/webhook-deliver';
import { runReap } from '@/lib/jobs/reap';
import { runAuditVerify } from '@/lib/jobs/audit-verify';
import { checkSessionHealth } from '@/lib/jobs/session-health';
import { checkAuthFailures } from '@/lib/jobs/auth-failure-alarm';

interface JobSpec {
  /** Stable name; also the Redis lock suffix. */
  name: string;
  /** Tick cadence in milliseconds. */
  intervalMs: number;
  /**
   * Redis lock TTL in milliseconds. Must sit safely above the job's expected
   * runtime so the lock self-heals if a process dies mid-run, but below the
   * next tick so a healthy run never blocks the following one.
   */
  lockTtlMs: number;
  /** The shared job body. Return value is ignored by the scheduler. */
  run: () => Promise<unknown>;
}

const JOBS: JobSpec[] = [
  {
    name: 'scheduled-dispatch',
    intervalMs: 60_000,
    lockTtlMs: 55_000,
    run: runScheduledDispatch,
  },
  {
    name: 'webhook-deliver',
    intervalMs: 60_000,
    lockTtlMs: 55_000,
    run: runWebhookDeliver,
  },
  {
    name: 'reap',
    intervalMs: 300_000,
    lockTtlMs: 280_000,
    run: runReap,
  },
  {
    // Direct session-disconnect alarm. Tight 60s cadence: "WhatsApp is down"
    // must surface promptly, not on the 5-minute reap sweep.
    name: 'session-health',
    intervalMs: 60_000,
    lockTtlMs: 55_000,
    run: checkSessionHealth,
  },
  {
    // Gateway-wide API-key auth-failure alarm. 60s cadence so a systemic auth
    // break (e.g. a rotated SERVER_PEPPER killing every key) surfaces in minutes
    // rather than being discovered days later by a customer.
    name: 'auth-failure',
    intervalMs: 60_000,
    lockTtlMs: 55_000,
    run: checkAuthFailures,
  },
  {
    name: 'audit-verify',
    intervalMs: 3_600_000,
    lockTtlMs: 3_500_000,
    run: runAuditVerify,
  },
];

const LOCK_PREFIX = 'wa:lock:job:';
const LOCK_TOKEN = 'locked';

/** Active interval handles, keyed by job name. Empty when stopped. */
const timers = new Map<string, NodeJS.Timeout>();
/** In-process re-entrancy guard, keyed by job name. */
const running = new Map<string, boolean>();

/**
 * Run one tick of a job: run the body under the in-process mutex, optionally
 * wrapped by the Redis cross-replica lock when SCHEDULER_DISTRIBUTED_LOCKS=1.
 * A failure to acquire either lock is a quiet no-op (another runner has it).
 */
async function tick(job: JobSpec): Promise<void> {
  // In-process mutex: never overlap a slow run with itself in this process.
  if (running.get(job.name)) {
    logger.debug({ job: job.name }, 'scheduler tick skipped: previous run still in flight');
    return;
  }

  // Single-instance assumption: with the flag unset (default) the
  // in-process mutex above is the only guard and this branch issues zero
  // Redis commands. The Redis SET NX PX / DEL lock only matters once more
  // than one instance can run this tick concurrently.
  if (env.SCHEDULER_DISTRIBUTED_LOCKS !== '1') {
    await runJob(job);
    return;
  }

  const redis = getRedis();
  const lockKey = `${LOCK_PREFIX}${job.name}`;

  let acquired = false;
  try {
    // SET NX PX, mirrors the SET NX EX nonce lock in @/lib/wire. `null` means
    // the key already exists (another replica/tick holds the lock).
    const res = await redis.set(lockKey, LOCK_TOKEN, 'PX', job.lockTtlMs, 'NX');
    acquired = res === 'OK';
  } catch (err: unknown) {
    logger.error(
      { job: job.name, err: (err as Error).message },
      'scheduler failed to acquire job lock',
    );
    return;
  }

  if (!acquired) {
    logger.debug({ job: job.name }, 'scheduler tick skipped: lock held elsewhere');
    return;
  }

  try {
    await runJob(job);
  } finally {
    try {
      await redis.del(lockKey);
    } catch (err: unknown) {
      // The lock will expire on its own via PX; log and move on.
      logger.warn(
        { job: job.name, err: (err as Error).message },
        'scheduler failed to release job lock (will expire via TTL)',
      );
    }
  }
}

/** Run the job body under the in-process re-entrancy guard. */
async function runJob(job: JobSpec): Promise<void> {
  running.set(job.name, true);
  try {
    await job.run();
  } catch (err: unknown) {
    // Fail loud: surface the error with context, never swallow it.
    logger.error(
      { job: job.name, err: (err as Error).message, stack: (err as Error).stack },
      'scheduler job run failed',
    );
  } finally {
    running.set(job.name, false);
  }
}

/**
 * Start the scheduler. Idempotent: calling it again while running is a no-op
 * (timers are only registered once). Use `stopScheduler()` to clear them.
 */
export function startScheduler(): void {
  if (timers.size > 0) {
    logger.debug('scheduler already running; start ignored');
    return;
  }
  for (const job of JOBS) {
    const handle = setInterval(() => {
      void tick(job);
    }, job.intervalMs);
    // Do not keep the event loop alive purely for the scheduler.
    handle.unref?.();
    timers.set(job.name, handle);
  }
  logger.info({ jobs: JOBS.map((j) => j.name) }, 'in-process scheduler started');
}

/**
 * Stop the scheduler: clear all interval timers. In-flight runs are allowed to
 * finish (their `finally` releases the Redis lock). Idempotent.
 */
export function stopScheduler(): void {
  for (const handle of timers.values()) {
    clearInterval(handle);
  }
  timers.clear();
  logger.info('in-process scheduler stopped');
}

/** Exposed for tests: the registered job specs (names, cadences, TTLs). */
export const __schedulerJobs = JOBS;

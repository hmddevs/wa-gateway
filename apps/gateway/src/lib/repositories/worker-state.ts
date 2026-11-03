/**
 * Worker state: heartbeat, pairing status, connection health.
 * One doc per worker (v1 = `primary`).
 */
import 'server-only';
import type { ObjectId } from 'mongodb';
import { col } from '../mongo';
import { TtlCache } from '../memory-cache';

export interface WorkerStateDoc {
  _id?: ObjectId;
  workerId: string;
  status: 'offline' | 'pairing' | 'connected' | 'degraded';
  lastHeartbeatAt?: Date | null;
  connectedAt?: Date | null;
  phoneE164?: string | null;
  deviceName?: string | null;
  version?: string | null;
  hostname?: string | null;
  publicIp?: string | null;
  queueDepth?: number;
  lastError?: { code: string; detail: string; at: Date } | null;
  tokenGen?: number;
  /** Soft-delete marker. Absent/null ⇒ live. Set by `deleteWorker` so a
   *  superseded `tokenGen` high-water survives admin deletion and old tokens
   *  stay revoked (see deleteWorker). */
  deletedAt?: Date | null;
}

export async function upsertWorker(
  workerId: string,
  patch: Partial<WorkerStateDoc>,
): Promise<WorkerStateDoc> {
  const c = await col<WorkerStateDoc>('worker_state');
  await c.updateOne({ workerId }, { $set: { workerId, ...patch } }, { upsert: true });
  const doc = await c.findOne({ workerId });
  if (!doc) throw new Error('worker upsert failed');
  // Write-through: invalidate the cache so a tokenGen bump (revoke / refresh)
  // propagates within the TTL rather than lingering for the cache lifetime.
  invalidateWorkerCache(workerId).catch(() => {});
  return doc;
}

export async function getWorker(workerId: string): Promise<WorkerStateDoc | null> {
  const c = await col<WorkerStateDoc>('worker_state');
  return c.findOne({ workerId });
}

/**
 * List every worker the gateway has ever heard from. Sorted by recent
 * heartbeat first so the admin UI can default-select the freshest one.
 *
 * Used by `GET /api/admin/workers` to populate the worker dropdown when
 * creating a new session, eliminates the friction of typing a workerId
 * by hand and the bug class of typing a wrong one.
 */
export async function listAllWorkers(): Promise<WorkerStateDoc[]> {
  const c = await col<WorkerStateDoc>('worker_state');
  // Exclude soft-deleted rows so the admin worker dropdown behaviour is
  // unchanged, a deleted worker disappears from the UI even though its row
  // (and tokenGen high-water) is retained to keep old tokens revoked.
  return c
    .find({ deletedAt: { $in: [null, undefined] } as never })
    .sort({ lastHeartbeatAt: -1 })
    .toArray();
}

/**
 * Soft-delete a worker_state row. Used by the admin DELETE route to clean up
 * ghost workers (e.g. an old `m1-main` row left behind after a wipe + reinstall
 * under a new workerId). Returns true if a matching row existed, false otherwise.
 *
 * why soft, not hard: a hard `deleteOne` drops `tokenGen`, so a later read sees
 * `currentGen = 0` and an old/revoked token would pass the strict `gen <
 * currentGen` wire check again, silently resurrecting a credential we meant to
 * kill. A soft delete instead bumps `tokenGen` to a high-water sentinel
 * (current + 1) and stamps `deletedAt`, so EVERY token ever issued to this
 * worker stays strictly below the stored gen and remains rejected for good.
 *
 * `listAllWorkers` filters out `deletedAt` rows, so the admin UI is unchanged.
 * A genuine re-bootstrap under the same workerId calls `/refresh`, which mints
 * gen = max(currentGen, …) + 1 and re-upserts the row (cache invalidated),
 * naturally clearing nothing but moving the high-water forward, the worker
 * just re-pairs as expected. To fully revive a soft-deleted worker the admin
 * re-bootstraps it; `deletedAt` is left in place until the next upsert.
 */
export async function deleteWorker(workerId: string): Promise<boolean> {
  const c = await col<WorkerStateDoc>('worker_state');
  const existing = await c.findOne({ workerId });
  if (!existing) return false;
  const sentinelGen = (existing.tokenGen ?? 0) + 1;
  await c.updateOne({ workerId }, { $set: { tokenGen: sentinelGen, deletedAt: new Date() } });
  invalidateWorkerCache(workerId).catch(() => {});
  return true;
}

/** Process-local 5s TTL cache. See memory-cache.ts for the single-instance
 *  assumption this relies on, a tokenGen bump only needs to propagate within
 *  this one process, so an in-process cache is sufficient (and correct) here. */
const workerCache = new TtlCache<WorkerStateDoc>(5000);

/**
 * Cached worker_state read with a 5s in-process TTL. Mirrors
 * `getCachedSession`. Keeps the hot worker-callback gen check cheap.
 */
export async function getCachedWorker(workerId: string): Promise<WorkerStateDoc | null> {
  const cached = workerCache.get(workerId);
  if (cached !== undefined) return cached;

  const doc = await getWorker(workerId);
  if (!doc) return null;

  workerCache.set(workerId, doc);
  return doc;
}

/**
 * Invalidate the worker cache entry. Called write-through from
 * `upsertWorker` / `deleteWorker`.
 */
export async function invalidateWorkerCache(workerId: string): Promise<void> {
  workerCache.del(workerId);
}

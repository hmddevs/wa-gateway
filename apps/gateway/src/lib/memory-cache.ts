/**
 * In-process TTL cache for private, per-request-hot-path reads.
 *
 * SINGLE-INSTANCE ASSUMPTION: the gateway runs as exactly one instance.
 * This cache lives in the process heap only, it is never shared
 * across instances and nothing external ever reads or writes it. That is
 * only safe because there is exactly one instance to go stale. If the
 * gateway is ever scaled to more than one machine, each instance would hold
 * an independent cache and a write on one instance would not invalidate the
 * cache on another, revisit every caller of `TtlCache` before any
 * horizontal scale-out.
 */
import 'server-only';

interface Entry<T> {
  value: T;
  expiresAt: number;
}

/** Small keyed TTL cache. Expiry is checked lazily on `get`; there is no
 *  background sweep, so an entry that is never re-read simply sits until
 *  overwritten or the process restarts. Fine at this size (one entry per
 *  session/worker), not a fit for high-cardinality or long-lived keys. */
export class TtlCache<T> {
  private readonly store = new Map<string, Entry<T>>();

  constructor(private readonly ttlMs: number) {}

  /** Returns the cached value by reference, not a clone. Callers must treat
   *  it as read-only: mutating a returned value corrupts the entry for every
   *  other reader until it expires or is invalidated. */
  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T): void {
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  del(key: string): void {
    this.store.delete(key);
  }
}

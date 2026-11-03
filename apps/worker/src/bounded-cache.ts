/**
 * Developed by HMD Developments
 * For HMD WA Gateway
 * www.hmddevs.org
 *
 * A fixed-size, recency-ordered in-memory cache.
 *
 * Shaped to satisfy Baileys' `CacheStore` (get / set / del / flushAll) so it can
 * be handed straight to `msgRetryCounterCache`, while also backing the sent-
 * message store behind `getMessage` and the group-metadata cache behind
 * `cachedGroupMetadata`. Those three are the entire reason this exists, a
 * dependency like `node-cache` would buy nothing a bounded Map does not, and
 * the worker holds one of these per session, so unbounded growth is the only
 * real hazard to design against.
 */
export class BoundedCache {
  private readonly entries = new Map<string, unknown>();

  constructor(private readonly max: number) {}

  /** Read a value, promoting it to most-recently-used. */
  get<T>(key: string): T | undefined {
    if (!this.entries.has(key)) return undefined;
    const value = this.entries.get(key) as T;
    // Re-insert so the eviction order below reflects use, not just insertion.
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  /** Write a value, evicting the least-recently-used entry when full. */
  set<T>(key: string, value: T): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    if (this.entries.size > this.max) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
  }

  del(key: string): void {
    this.entries.delete(key);
  }

  flushAll(): void {
    this.entries.clear();
  }
}

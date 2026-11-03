/**
 * Node-runtime instrumentation.
 *
 * Split out of `instrumentation.ts` so the edge runtime bundle (produced
 * because the app ships a `middleware.ts`) never traces the Node-only
 * scheduler and its `ioredis` dependency. This module is dynamic-imported by
 * `instrumentation.ts` only when `NEXT_RUNTIME === 'nodejs'` and
 * `SCHEDULER_ENABLED === '1'`.
 */
import { startScheduler } from './lib/scheduler';

startScheduler();

// Eagerly warm the Mongo pool and Redis connection at boot so the first real
// request does not pay the connect + index-ensure cost. Fail-soft: a warmup
// error must never crash the process, the lazy path will retry on first use.
void (async () => {
  try {
    const { getMongo } = await import('./lib/mongo');
    await getMongo();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error({ err: (err as Error).message }, '[warmup] mongo pre-warm failed');
  }
  try {
    const { getRedis } = await import('./lib/redis');
    await getRedis().ping();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error({ err: (err as Error).message }, '[warmup] redis pre-warm failed');
  }
})();

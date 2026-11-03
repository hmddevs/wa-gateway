/**
 * Next.js instrumentation hook.
 *
 * Runs once per server process at startup. We use it to start the in-process
 * job scheduler for the long-running (self-hosted) deployment, gated behind:
 *
 *   - `NEXT_RUNTIME === 'nodejs'`, never load the scheduler on the edge
 *     runtime (it needs ioredis + the Node-only job bodies).
 *   - `SCHEDULER_ENABLED === '1'`, feature flag, OFF by default. On Vercel,
 *     where Vercel cron drives the jobs over HTTP, this stays unset.
 *
 * The Node-only side-effect module (`./instrumentation-node`, which pulls in
 * the scheduler and its `ioredis` dependency) is dynamically imported inside
 * the guard so the edge runtime bundle never traces it.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.SCHEDULER_ENABLED !== '1') return;

  await import('./instrumentation-node');
}

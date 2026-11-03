/**
 * Edge-runtime stub for `instrumentation-node.ts`.
 *
 * The real module starts the Node-only in-process scheduler (ioredis, Mongo,
 * etc.) and must never be bundled for the edge runtime. `next.config.mjs`
 * swaps the real module for this empty stub in the edge build via
 * NormalModuleReplacementPlugin. It is intentionally side-effect free: the
 * scheduler only ever runs under `NEXT_RUNTIME === 'nodejs'`.
 */
export {};

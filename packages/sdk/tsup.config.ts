import { defineConfig } from 'tsup';

/**
 * Dual ESM/CJS bundle. We inline `@hmddevs/protocol` so consumers get a
 * single zero-dep artefact (the protocol package is workspace-private and
 * unpublishable; bundling is mandatory).
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node20',
  splitting: false,
  treeshake: true,
  noExternal: ['@hmddevs/protocol'],
});

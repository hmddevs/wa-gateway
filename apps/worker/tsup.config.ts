import { defineConfig } from 'tsup';

/**
 * Build worker to a single CJS bundle for @yao-pkg/pkg to wrap into a
 * standalone Mach-O binary (node20-macos-arm64).
 */
export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'dist',
  format: ['cjs'],
  target: 'node20',
  platform: 'node',
  sourcemap: true,
  clean: true,
  minify: false,
  splitting: false,
  shims: false,
  // Inline EVERYTHING into a single self-contained CJS file so the worker
  // can be shipped alongside a Node 20 binary with no node_modules folder.
  // pkg has known TLS/WebSocket bugs that break Baileys, so we ship plain
  // Node + bundled JS instead.
  noExternal: [/.*/],
});

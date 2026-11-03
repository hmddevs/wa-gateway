import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    // server-only is a Next.js guard that throws if imported outside RSC. In
    // Vitest it needs to be a no-op so the modules under test can be imported.
    server: {
      deps: {
        // Allow importing CJS deps without transformation issues.
        inline: [],
      },
    },
    include: ['src/**/__tests__/**/*.test.ts', 'src/**/test/**/*.test.ts'],
    globals: false,
  },
  resolve: {
    alias: {
      // Mirror the `@/*` → `src/*` path alias declared in tsconfig.json.
      '@': path.resolve(__dirname, './src'),
      // Stub out Next.js's server-only guard so modules that import it can be
      // loaded in Vitest's Node environment.
      'server-only': path.resolve(__dirname, '../../packages/config/server-only-stub.js'),
    },
  },
});

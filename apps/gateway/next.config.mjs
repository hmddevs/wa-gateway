// @ts-check
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

const edgeInstrumentationStub = fileURLToPath(
  new URL('./src/instrumentation-node.edge-stub.js', import.meta.url),
);

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Produce a self-contained Node.js server under .next/standalone.
  // Required for the Docker container deployment.
  output: 'standalone',

  // Tell Next's file-tracing to walk UP to the monorepo root so that
  // workspace packages (e.g. @hmddevs/protocol in packages/protocol) are
  // included in the traced output. This is the stable top-level key in
  // Next.js >=13.2; do NOT nest it under `experimental`.
  outputFileTracingRoot: path.resolve(__dirname, '../..'),

  reactStrictMode: true,
  poweredByHeader: false,
  // Security headers are authoritative in `src/middleware.ts` to apply to ALL
  // paths incl. Server Actions. We still keep `headers()` here as defence in
  // depth for the edge network cache.
  async headers() {
    return [
      {
        // Edge-cache defence-in-depth only. The AUTHORITATIVE security headers,
        // including `X-Robots-Tag: noindex, nofollow` for zero discoverability,
        // are set in `src/middleware.ts` (SECURITY_HEADERS), which actually runs
        // for the public static corpus (/llms.txt, /llms-full.txt, /openapi.json)
        // whereas `next.config` headers do not reliably reach public files under
        // `output: 'standalone'`.
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
          },
        ],
      },
    ];
  },
  // `/docs/<slug>.md` → the Markdown export of that docs page (backs the
  // "Copy page as Markdown" feature). Only paths ending in literal `.md`
  // divert here; `.md`-less paths (the actual `/docs/:path*` pages) are
  // real filesystem routes and are never touched by this rule, so nothing
  // shadows the normal docs pages. See app/api/docs-md/route.ts (root
  // `/docs.md`) and app/api/docs-md/[...path]/route.ts (nested pages).
  async rewrites() {
    return [
      { source: '/docs.md', destination: '/api/docs-md' },
      { source: '/docs/:slug*.md', destination: '/api/docs-md/:slug*' },
    ];
  },
  // Transpile the shared protocol package from source.
  transpilePackages: ['@hmddevs/protocol'],
  experimental: {
    // Serialise Server Action results; never expose stack traces.
    serverActions: {
      bodySizeLimit: '64kb',
    },
  },
  // No image optimisation fetching from arbitrary hosts.
  images: {
    remotePatterns: [],
  },
  // The in-process scheduler (started from `instrumentation.ts` on the Node
  // runtime only) is implemented in `instrumentation-node.ts`, which pulls in
  // `ioredis`, the Mongo client and other Node-only libraries. Because the app
  // ships a `middleware.ts`, Next also produces an EDGE instrumentation bundle
  // and webpack traces the guarded dynamic import into it, failing to resolve
  // Node core modules (`crypto`, `dns`, `net`, `fs/promises`, …). That code is
  // unreachable on the edge runtime (gated behind `NEXT_RUNTIME === 'nodejs'`),
  // so for the edge build we swap the entire `instrumentation-node` module for
  // an empty stub. The Node build is left untouched.
  webpack(config, { nextRuntime, webpack }) {
    if (nextRuntime === 'edge') {
      config.plugins.push(
        new webpack.NormalModuleReplacementPlugin(
          /instrumentation-node(\.ts)?$/,
          edgeInstrumentationStub,
        ),
      );
    }
    return config;
  },
};

export default nextConfig;

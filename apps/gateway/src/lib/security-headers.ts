/**
 * Security headers applied on every response (Node + Edge runtime).
 * The CSP is strict; tweaks require a SECURITY-IMPACT paragraph in the PR.
 */

/**
 * SECURITY-IMPACT: `'unsafe-eval'` is added to `script-src` in development ONLY.
 *
 * Next's dev server compiles client modules with eval-based source maps and
 * Fast Refresh, so without it no client component ever hydrates and
 * `pnpm dev:gateway` renders a permanently-skeleton page, the admin dashboard
 * and the public pairing page are both unusable locally. Production builds
 * contain no eval, and `NODE_ENV` is `production` on every deployed target,
 * so the deployed policy is byte-for-byte what it was before this change.
 */
const DEV_SCRIPT_SRC = process.env.NODE_ENV === 'production' ? '' : " 'unsafe-eval'";

export const CSP = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${DEV_SCRIPT_SRC}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
  'upgrade-insecure-requests',
].join('; ');

export const SECURITY_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ['Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload'],
  ['Content-Security-Policy', CSP],
  ['X-Content-Type-Options', 'nosniff'],
  ['X-Frame-Options', 'DENY'],
  ['Referrer-Policy', 'strict-origin-when-cross-origin'],
  ['Permissions-Policy', 'camera=(), microphone=(), geolocation=(), interest-cohort=()'],
  ['Cross-Origin-Opener-Policy', 'same-origin'],
  ['Cross-Origin-Resource-Policy', 'same-origin'],
  ['Cache-Control', 'private, no-store, max-age=0'],
  // Zero discoverability: the gateway is invite-only and must never be indexed
  // or surfaced by a search engine or AI crawler. This per-response signal
  // complements `robots.txt` (Disallow: /) and the layout `robots: false`, and
  // crucially also covers the public static corpus (/llms.txt, /llms-full.txt,
  // /openapi.json) which the middleware runs for but `next.config` headers and
  // the layout metadata do not reliably reach.
  ['X-Robots-Tag', 'noindex, nofollow'],
];

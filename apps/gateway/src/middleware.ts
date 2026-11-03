/**
 * Next.js middleware, runs on the Edge for every request.
 * Responsibilities:
 *   1. Cloudflare-origin lock (W4.3): when enforced, reject any request that
 *      did not arrive through Cloudflare, so an attacker cannot bypass the
 *      Cloudflare WAF by hitting the origin IP directly.
 *   2. Stamp / propagate `X-Request-Id`.
 *   3. Apply security headers to every response.
 *   4. Enforce HTTPS in production (redirect http → https).
 * Rate limiting, firewall rules, and auth live in route handlers.
 *
 * Edge-runtime note: this module and everything it imports must be edge-safe
 * (pure JS, no node:* APIs, no `server-only`). `cidr`, `cloudflare-ips`, and
 * `internal-ips` are BigInt/string-only and safe. The `ENFORCE_CLOUDFLARE_ORIGIN`
 * and `TRUSTED_CLIENT_IP_HEADER` flags are read straight from `process.env`
 * rather than via `@/lib/env`, which is server-only and would break the edge
 * bundle.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { mintRequestId, REQUEST_ID_HEADER } from '@/lib/request-id';
import { SECURITY_HEADERS } from '@/lib/security-headers';
import { matchAnyCidr } from '@/lib/cidr';
import { CLOUDFLARE_IPV4_RANGES, CLOUDFLARE_IPV6_RANGES } from '@/lib/cloudflare-ips';
import { INTERNAL_RANGES } from '@/lib/internal-ips';

export const config = {
  // Run on everything except static assets.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)'],
};

const CLOUDFLARE_RANGES = [...CLOUDFLARE_IPV4_RANGES, ...CLOUDFLARE_IPV6_RANGES];

/**
 * Cloudflare-origin lock. Returns a 403 response when the request did NOT
 * arrive through Cloudflare and the flag is on; otherwise returns null and the
 * request proceeds.
 *
 * Exemption order (infra MUST pass before any fail-closed check):
 *   1. Flag off → no enforcement at all (default; zero behaviour change).
 *   2. Path `/api/health` → the host's own health probe connects from inside
 *      the deployment, not via Cloudflare. Blocking it would mark the
 *      instance unhealthy and take prod down. Always allow.
 *   3. Path prefix `/v1/worker/` → worker callbacks arrive over the private
 *      network; the trusted-header peer IP is a private-range address, never
 *      a CF range. Always allow.
 *   4. Peer IP inside the deployment's internal/private-network space →
 *      legitimate intra-infra traffic (infra/health/worker on any path).
 *      Always allow.
 *   5. Peer IP inside a published Cloudflare range → genuinely arrived via
 *      Cloudflare. Allow.
 *   6. Otherwise (including absent/unconfigured trusted header) → fail
 *      CLOSED, 403.
 *
 * The CF-detection predicate is `matchAnyCidr(peerIp, CLOUDFLARE_RANGES)` on
 * the header named by `TRUSTED_CLIENT_IP_HEADER` ONLY, the origin's immediate
 * TCP peer, which is unspoofable from outside the deployment. If that env var
 * is unset there is no trusted peer signal at all, so step 6 fires
 * unconditionally. `X-Forwarded-For` / `CF-Connecting-IP` are
 * attacker-controlled and never consulted for this decision.
 */
function enforceCloudflareOrigin(req: NextRequest): NextResponse | null {
  if (process.env.ENFORCE_CLOUDFLARE_ORIGIN !== '1') return null;

  const pathname = req.nextUrl.pathname;

  // (2) + (3) Path exemptions, infra paths checked first so they can never trip.
  if (pathname === '/api/health' || pathname.startsWith('/v1/worker/')) {
    return null;
  }

  const trustedIpHeader = process.env.TRUSTED_CLIENT_IP_HEADER?.trim();
  const peerIp = trustedIpHeader ? req.headers.get(trustedIpHeader)?.trim() : undefined;

  // (4) Internal/private-network peer → always allow (defence so
  // infra/health/worker traffic never blocks even on unexpected paths).
  if (peerIp && matchAnyCidr(peerIp, INTERNAL_RANGES)) {
    return null;
  }

  // (5) Genuinely behind Cloudflare → allow.
  if (peerIp && matchAnyCidr(peerIp, CLOUDFLARE_RANGES)) {
    return null;
  }

  // (6) Unknown / absent / unconfigured peer → fail closed. Log a coarse peer
  // indicator only (no secrets/PII); a truncated IP is acceptable for a
  // security warn.
  const peerHint = peerIp ? truncateIp(peerIp) : 'absent';
  // eslint-disable-next-line no-console
  console.warn(`[origin-lock] rejected non-Cloudflare request path=${pathname} peer=${peerHint}`);

  return new NextResponse('Forbidden', {
    status: 403,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}

/** Coarsen an IP for security logs: keep enough to triage, drop host bits. */
function truncateIp(ip: string): string {
  if (ip.indexOf(':') !== -1) {
    // IPv6 → keep the first two hextets (the routing prefix).
    return ip.split(':').slice(0, 2).join(':') + '::/32';
  }
  // IPv4 → keep the /24.
  const octets = ip.split('.');
  return octets.length === 4 ? `${octets[0]}.${octets[1]}.${octets[2]}.0/24` : 'malformed';
}

export function middleware(req: NextRequest): NextResponse {
  // Origin lock runs first: a request that should never have reached the
  // origin gets nothing further (no security headers, no request-id leak).
  const blocked = enforceCloudflareOrigin(req);
  if (blocked) return blocked;

  const url = req.nextUrl;
  const isProd = process.env.NODE_ENV === 'production';

  // Worker→gateway calls travel over the deployment's private network as
  // plain HTTP (`http://hmd-wa-gateway.internal:3000`), never TLS. They are authenticated
  // by worker JWT + HMAC at the route layer, not gated by transport TLS, so the
  // http→https redirect must not fire for them, a 308 would break the worker.
  // The exemption is scoped to `/v1/worker/*` only; every browser, admin, and
  // public-API path still gets force-upgraded. External `/v1/messages` clients
  // reach the public edge with `x-forwarded-proto: https`, so they are unaffected.
  const isWorkerApi = url.pathname.startsWith('/v1/worker/');

  if (isProd && url.protocol === 'http:' && !isWorkerApi) {
    const httpsUrl = new URL(url.toString());
    httpsUrl.protocol = 'https:';
    return NextResponse.redirect(httpsUrl, 308);
  }

  const requestId = mintRequestId(req.headers.get(REQUEST_ID_HEADER));

  // Forward the id on to the handler.
  const forwardedHeaders = new Headers(req.headers);
  forwardedHeaders.set(REQUEST_ID_HEADER, requestId);

  const res = NextResponse.next({ request: { headers: forwardedHeaders } });

  for (const [k, v] of SECURITY_HEADERS) res.headers.set(k, v);
  res.headers.set('X-Request-Id', requestId);

  return res;
}

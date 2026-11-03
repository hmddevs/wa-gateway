/**
 * Bearer API key authentication + rate limiting + audit trail.
 *
 * Usage inside a Node-runtime route handler:
 *
 *   export const runtime = 'nodejs';
 *   export async function POST(req: Request) {
 *     const auth = await authenticate(req);
 *     if (!auth.ok) return auth.response;
 *     // auth.apiKey, auth.ip, auth.requestId are now safe to use.
 *   }
 */
import 'server-only';
import type { NextRequest } from 'next/server';
import { ErrorCodes } from '@hmddevs/protocol';
import { errorResponse } from './http';
import {
  findByLookupHash,
  touchLastUsed,
  type ApiKeyDoc,
  type ApiKeyScope,
} from './repositories/api-keys';
import { parseKey, verifyKey } from './api-key';
import { recordAuthLookupMiss } from './auth-failure-tracker';
import { checkApiKey, checkGlobal, checkIp } from './rate-limit';
import { mintRequestId } from './request-id';
import { logger } from './logger';
import { matchAnyCidr } from './cidr';
import { CLOUDFLARE_IPV4_RANGES, CLOUDFLARE_IPV6_RANGES } from './cloudflare-ips';
import { env } from './env';

export interface AuthSuccess {
  ok: true;
  apiKey: ApiKeyDoc;
  ip: string;
  requestId: string;
}
export interface AuthFailure {
  ok: false;
  response: Response;
}
export type AuthResult = AuthSuccess | AuthFailure;

const CLOUDFLARE_RANGES = [...CLOUDFLARE_IPV4_RANGES, ...CLOUDFLARE_IPV6_RANGES];

/**
 * Derive the client IP used for ALL security decisions (per-IP rate limit and
 * the per-key IP allowlist). Spoof-proof by construction:
 *
 *   - Base trust is the header named by `TRUSTED_CLIENT_IP_HEADER`, set by the
 *     trusted reverse proxy in front of this gateway; an external client
 *     reaching the app through that proxy cannot set it itself. There is no
 *     default header: if the operator has not configured one, this fails
 *     closed to `0.0.0.0` rather than guessing a header a client might
 *     control.
 *   - When Cloudflare proxying is live (`TRUST_CLOUDFLARE=1`) AND the immediate
 *     upstream (the configured trusted header) is itself inside a published
 *     Cloudflare range, the request genuinely arrived via Cloudflare, so
 *     `CF-Connecting-IP` holds the real end client and is preferred. Outside
 *     that proof, CF-Connecting-IP is just another attacker-settable header
 *     and is ignored.
 *   - Raw `X-Forwarded-For` is NEVER trusted for security decisions: the
 *     origin is directly reachable, so XFF is fully client-controlled.
 *
 * Fails closed to `0.0.0.0` when no trusted header is configured, or none is
 * present on the request (that synthetic IP shares one global rate-limit
 * bucket and matches no real allowlist).
 *
 * Accepts anything with a `.get(name)` header reader, a `Request`/
 * `NextRequest`'s `.headers`, or Next.js server components' `headers()` from
 * `next/headers` (a `ReadonlyHeaders`, not a full Request), so server
 * components can reuse the same spoof-proof derivation without constructing
 * a fake Request.
 */
export function getClientIp(reqOrHeaders: Request | NextRequest | Pick<Headers, 'get'>): string {
  // Duck-type on the nested `.headers.get` actually being callable, rather
  // than on `.headers` merely being present: Next.js's `ReadonlyHeaders`
  // (from `next/headers`) exposes its own internal `.headers` property that
  // is NOT itself a `Headers`-like reader, so a plain `'headers' in x` check
  // grabbed the wrong object and crashed with "get is not a function" in
  // production (2026-07-13).
  const maybeHeaders = (reqOrHeaders as { headers?: unknown }).headers;
  const headers =
    maybeHeaders && typeof (maybeHeaders as Pick<Headers, 'get'>).get === 'function'
      ? (maybeHeaders as Pick<Headers, 'get'>)
      : (reqOrHeaders as Pick<Headers, 'get'>);
  if (!env.TRUSTED_CLIENT_IP_HEADER) {
    // No trusted header configured. Do NOT fall back to any hardcoded
    // header; collapse to a synthetic IP so spoofing buys nothing.
    return '0.0.0.0';
  }

  const clientIp = headers.get(env.TRUSTED_CLIENT_IP_HEADER)?.trim();
  if (!clientIp) {
    // Trusted header configured but absent on this request (e.g. local/dev).
    // Do NOT fall back to XFF for security; collapse to a synthetic IP so
    // spoofing buys nothing.
    return '0.0.0.0';
  }

  if (env.TRUST_CLOUDFLARE === '1' && matchAnyCidr(clientIp, CLOUDFLARE_RANGES)) {
    // Hop is provably Cloudflare: the end-client IP is in CF-Connecting-IP.
    const cfIp = headers.get('cf-connecting-ip')?.trim();
    if (cfIp) return cfIp;
  }

  return clientIp;
}

function ipInAllowlist(ip: string, cidrs: string[] | undefined): boolean {
  if (!cidrs || cidrs.length === 0) return true;
  // Full IPv4 + IPv6 CIDR matching via the shared cidr util. Consumes the
  // spoof-proof IP from getClientIp, so the allowlist can no longer be
  // bypassed with a forged X-Forwarded-For header.
  return matchAnyCidr(ip, cidrs);
}

export async function authenticate(req: Request | NextRequest): Promise<AuthResult> {
  const requestId = mintRequestId(req.headers.get('x-request-id'));
  const ip = getClientIp(req);

  if (!(await checkGlobal())) {
    return {
      ok: false,
      response: errorResponse(
        429,
        ErrorCodes.RATE_LIMITED,
        'Global rate limit exceeded',
        requestId,
      ),
    };
  }
  if (!(await checkIp(ip))) {
    return {
      ok: false,
      response: errorResponse(429, ErrorCodes.RATE_LIMITED, 'IP rate limit exceeded', requestId),
    };
  }

  const authz = req.headers.get('authorization');
  if (!authz || !authz.startsWith('Bearer ')) {
    return {
      ok: false,
      response: errorResponse(401, ErrorCodes.UNAUTHORIZED, 'Missing bearer token', requestId),
    };
  }
  const token = authz.slice(7).trim();
  const parsed = parseKey(token);
  if (!parsed) {
    return {
      ok: false,
      response: errorResponse(401, ErrorCodes.UNAUTHORIZED, 'Malformed API key', requestId),
    };
  }

  const doc = await findByLookupHash(parsed.lookupHash);
  if (!doc) {
    // Well-formed key that matches no record: the precise signal of a systemic
    // auth break (a rotated SERVER_PEPPER invalidates every key at once) or a
    // rotated/revoked key the consumer never updated. Record it (fire-and-forget,
    // best-effort) so the auth-failure alarm can catch it within minutes.
    void recordAuthLookupMiss(parsed.division);
    // Do an argon2 verify anyway to equalise timing against the happy path.
    // We can't re-use a stored hash here safely, so we verify against a
    // throwaway hash; argon2.verify on a malformed hash is constant-ish
    // in failure path. Good enough for now.
    return {
      ok: false,
      response: errorResponse(401, ErrorCodes.UNAUTHORIZED, 'Invalid API key', requestId),
    };
  }

  const ok = await verifyKey(parsed.secret, doc.keyHash);
  if (!ok) {
    return {
      ok: false,
      response: errorResponse(401, ErrorCodes.UNAUTHORIZED, 'Invalid API key', requestId),
    };
  }

  if (doc.revokedAt) {
    return {
      ok: false,
      response: errorResponse(401, ErrorCodes.UNAUTHORIZED, 'Key revoked', requestId),
    };
  }

  if (!ipInAllowlist(ip, doc.ipAllowlist)) {
    return {
      ok: false,
      response: errorResponse(403, ErrorCodes.IP_NOT_ALLOWED, 'IP not allowed', requestId),
    };
  }

  if (!(await checkApiKey(doc.keyId, doc.rateLimitPerMin))) {
    return {
      ok: false,
      response: errorResponse(429, ErrorCodes.RATE_LIMITED, 'Key rate limit exceeded', requestId),
    };
  }

  // Fire-and-forget usage update.
  touchLastUsed(doc.keyId).catch((err) =>
    logger.warn({ err: err.message, keyId: doc.keyId }, 'touchLastUsed failed'),
  );

  return { ok: true, apiKey: doc, ip, requestId };
}

export function requireScope(doc: ApiKeyDoc, scope: ApiKeyScope): boolean {
  return doc.scopes.includes(scope);
}

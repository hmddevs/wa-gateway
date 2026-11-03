/**
 * Cloudflare-origin lock (W4.3) enforcement in the edge middleware.
 *
 * The decision rests solely on the configured `TRUSTED_CLIENT_IP_HEADER`
 * (the origin's immediate TCP peer, unspoofable from outside the deployment).
 * We assert the full exemption order: flag off → no enforcement; /api/health
 * and /v1/worker/* always pass; internal-network peers pass; CF-range peers
 * pass; everything else 403s when the flag is on. The flag is read from
 * process.env, so we toggle it per test. Test fixtures still use the literal
 * header name `fly-client-ip` as the configured header, purely as example
 * data.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from '../middleware';

const ORIG = process.env.ENFORCE_CLOUDFLARE_ORIGIN;
const ORIG_HEADER = process.env.TRUSTED_CLIENT_IP_HEADER;

function req(path: string, headers: Record<string, string> = {}): NextRequest {
  // Use the internal (non-TLS) host so the https-redirect branch never fires
  // and we isolate the origin-lock behaviour.
  return new NextRequest(`http://hmd-wa-gateway.internal${path}`, { headers });
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  process.env.TRUSTED_CLIENT_IP_HEADER = 'fly-client-ip';
});

afterEach(() => {
  if (ORIG === undefined) delete process.env.ENFORCE_CLOUDFLARE_ORIGIN;
  else process.env.ENFORCE_CLOUDFLARE_ORIGIN = ORIG;
  if (ORIG_HEADER === undefined) delete process.env.TRUSTED_CLIENT_IP_HEADER;
  else process.env.TRUSTED_CLIENT_IP_HEADER = ORIG_HEADER;
  vi.restoreAllMocks();
});

describe('origin lock, flag off (default)', () => {
  it('allows a non-Cloudflare public peer when flag is unset', () => {
    delete process.env.ENFORCE_CLOUDFLARE_ORIGIN;
    const res = middleware(req('/v1/messages', { 'fly-client-ip': '8.8.8.8' }));
    expect(res.status).not.toBe(403);
  });

  it('allows everything when flag is explicitly "0"', () => {
    process.env.ENFORCE_CLOUDFLARE_ORIGIN = '0';
    const res = middleware(req('/admin', { 'fly-client-ip': '203.0.113.10' }));
    expect(res.status).not.toBe(403);
  });
});

describe('origin lock, flag on', () => {
  beforeEach(() => {
    process.env.ENFORCE_CLOUDFLARE_ORIGIN = '1';
  });

  it('allows a peer inside a Cloudflare range', () => {
    // 173.245.48.0/20 is a published Cloudflare range.
    const res = middleware(req('/v1/messages', { 'fly-client-ip': '173.245.48.5' }));
    expect(res.status).not.toBe(403);
  });

  it('allows a Cloudflare IPv6 peer', () => {
    const res = middleware(req('/admin', { 'fly-client-ip': '2606:4700::1' }));
    expect(res.status).not.toBe(403);
  });

  it('403s a non-Cloudflare public peer', () => {
    const res = middleware(req('/v1/messages', { 'fly-client-ip': '8.8.8.8' }));
    expect(res.status).toBe(403);
  });

  it('403s when the trusted header is absent (fail closed)', () => {
    const res = middleware(req('/v1/messages'));
    expect(res.status).toBe(403);
  });

  it('always allows /api/health (health probe) regardless of peer', () => {
    const res = middleware(req('/api/health', { 'fly-client-ip': '8.8.8.8' }));
    expect(res.status).not.toBe(403);
  });

  it('always allows /api/health with no peer header', () => {
    const res = middleware(req('/api/health'));
    expect(res.status).not.toBe(403);
  });

  it('always allows /v1/worker/* (6PN callbacks)', () => {
    const res = middleware(req('/v1/worker/callback', { 'fly-client-ip': 'fdaa:0:1::3' }));
    expect(res.status).not.toBe(403);
  });

  it('allows a internal-network peer on any path', () => {
    const res = middleware(req('/v1/messages', { 'fly-client-ip': 'fdaa:0:1::3' }));
    expect(res.status).not.toBe(403);
  });

  it('does NOT trust CF-Connecting-IP or X-Forwarded-For for the decision', () => {
    // Spoofed CF headers with a non-CF immediate peer must still be rejected.
    const res = middleware(
      req('/v1/messages', {
        'fly-client-ip': '8.8.8.8',
        'cf-connecting-ip': '173.245.48.5',
        'x-forwarded-for': '173.245.48.5',
      }),
    );
    expect(res.status).toBe(403);
  });

  it('returns a minimal, non-leaky 403 body', async () => {
    const res = middleware(req('/v1/messages', { 'fly-client-ip': '8.8.8.8' }));
    expect(res.status).toBe(403);
    const body = await res.text();
    expect(body).toBe('Forbidden');
  });

  it('403s even a Cloudflare-range peer when TRUSTED_CLIENT_IP_HEADER is unset (fail closed)', () => {
    delete process.env.TRUSTED_CLIENT_IP_HEADER;
    const res = middleware(req('/v1/messages', { 'fly-client-ip': '173.245.48.5' }));
    expect(res.status).toBe(403);
  });
});

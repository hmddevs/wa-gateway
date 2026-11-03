/**
 * Spoof-proof client-IP derivation + IP allowlist. Most cases are exercised
 * indirectly through `authenticate()`, asserting the IP handed to the per-IP
 * rate limiter (checkIp) and the allowlist outcome (403 IP_NOT_ALLOWED vs
 * pass) for forged vs trusted headers. `getClientIp` is also exported
 * directly (server components pass it a bare `next/headers` `ReadonlyHeaders`
 * rather than a full `Request`) and is tested directly below.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mutable env so individual tests can flip TRUST_CLOUDFLARE. Hoisted so the
// vi.mock factory (also hoisted) can close over it safely.
const envState = vi.hoisted(() => ({
  TRUST_CLOUDFLARE: '0' as '0' | '1',
  RATE_LIMIT_IP_PER_MIN: 1200,
  TRUSTED_CLIENT_IP_HEADER: 'fly-client-ip' as string | undefined,
}));
vi.mock('@/lib/env', () => ({ env: envState }));

vi.mock('@/lib/rate-limit', () => ({
  checkGlobal: vi.fn().mockResolvedValue(true),
  checkIp: vi.fn().mockResolvedValue(true),
  checkApiKey: vi.fn().mockResolvedValue(true),
}));

vi.mock('@/lib/repositories/api-keys', () => ({
  findByLookupHash: vi.fn(),
  touchLastUsed: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/api-key', () => ({
  parseKey: vi.fn().mockReturnValue({ lookupHash: 'lh', secret: 'sec' }),
  verifyKey: vi.fn().mockResolvedValue(true),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { authenticate, getClientIp } from '../auth-api';
import { checkIp } from '../rate-limit';
import { findByLookupHash } from '../repositories/api-keys';

const mockCheckIp = checkIp as ReturnType<typeof vi.fn>;
const mockFind = findByLookupHash as ReturnType<typeof vi.fn>;

function makeReq(headers: Record<string, string>, allowlist?: string[]): Request {
  mockFind.mockResolvedValue({
    keyId: 'k1',
    keyHash: 'h',
    revokedAt: null,
    scopes: ['send'],
    rateLimitPerMin: 60,
    ipAllowlist: allowlist,
  });
  return new Request('https://gw.example/v1/messages', {
    method: 'POST',
    headers: { authorization: 'Bearer wa_test', ...headers },
  });
}

beforeEach(() => {
  envState.TRUST_CLOUDFLARE = '0';
  envState.TRUSTED_CLIENT_IP_HEADER = 'fly-client-ip';
  mockCheckIp.mockClear();
  mockCheckIp.mockResolvedValue(true);
});

describe('getClientIp, spoof resistance', () => {
  it('ignores X-Forwarded-For entirely; uses the trusted header', async () => {
    await authenticate(
      makeReq({
        'x-forwarded-for': '1.2.3.4',
        'fly-client-ip': '203.0.113.7',
      }),
    );
    expect(mockCheckIp).toHaveBeenCalledWith('203.0.113.7');
  });

  it('falls closed to 0.0.0.0 when the trusted header is absent, even with forged XFF/x-real-ip', async () => {
    await authenticate(
      makeReq({
        'x-forwarded-for': '9.9.9.9',
        'x-real-ip': '8.8.8.8',
      }),
    );
    expect(mockCheckIp).toHaveBeenCalledWith('0.0.0.0');
  });

  it('does NOT honour CF-Connecting-IP when source is not a CF range', async () => {
    envState.TRUST_CLOUDFLARE = '1';
    await authenticate(
      makeReq({
        'fly-client-ip': '203.0.113.7', // not a CF range
        'cf-connecting-ip': '6.6.6.6', // attacker-supplied
      }),
    );
    expect(mockCheckIp).toHaveBeenCalledWith('203.0.113.7');
  });

  it('does NOT honour CF-Connecting-IP when TRUST_CLOUDFLARE is off, even from a CF hop', async () => {
    envState.TRUST_CLOUDFLARE = '0';
    await authenticate(
      makeReq({
        'fly-client-ip': '104.16.5.5', // genuine CF range
        'cf-connecting-ip': '203.0.113.9',
      }),
    );
    expect(mockCheckIp).toHaveBeenCalledWith('104.16.5.5');
  });

  it('honours CF-Connecting-IP only when the trusted header is a CF range AND flag on', async () => {
    envState.TRUST_CLOUDFLARE = '1';
    await authenticate(
      makeReq({
        'fly-client-ip': '104.16.5.5', // genuine CF range
        'cf-connecting-ip': '203.0.113.9', // real end client
      }),
    );
    expect(mockCheckIp).toHaveBeenCalledWith('203.0.113.9');
  });
});

describe('getClientIp, accepts a bare Headers-like reader (server components)', () => {
  it('reads the trusted header from a plain Headers instance (no .headers wrapper)', () => {
    const headers = new Headers({ 'fly-client-ip': '203.0.113.7' });
    expect(getClientIp(headers)).toBe('203.0.113.7');
  });

  it('does not crash when the object has its own `.headers` property that is NOT itself a Headers-like reader', () => {
    // Regression for the 2026-07-13 production incident: Next.js's
    // `ReadonlyHeaders` (from `next/headers`) exposes an internal `.headers`
    // property that is not itself `.get`-able. A naive `'headers' in x` check
    // grabbed that internal property instead of the real reader and crashed
    // with "get is not a function" when rendering /pair/[token].
    const fakeReadonlyHeaders = {
      headers: { notAHeadersInstance: true }, // present, but no .get
      get(name: string) {
        if (name === 'fly-client-ip') return '203.0.113.9';
        return null;
      },
    } as unknown as Headers;
    expect(getClientIp(fakeReadonlyHeaders)).toBe('203.0.113.9');
  });

  it('still unwraps a real Request/NextRequest via its .headers', () => {
    const req = new Request('https://gw.example/pair/tok', {
      headers: { 'fly-client-ip': '203.0.113.11' },
    });
    expect(getClientIp(req)).toBe('203.0.113.11');
  });
});

describe('getClientIp, TRUSTED_CLIENT_IP_HEADER', () => {
  it('reads the configured header name, ignoring any other header', () => {
    envState.TRUSTED_CLIENT_IP_HEADER = 'x-real-ip';
    const headers = new Headers({
      'x-real-ip': '203.0.113.21',
      'fly-client-ip': '198.51.100.1', // not the configured header; must be ignored
    });
    expect(getClientIp(headers)).toBe('203.0.113.21');

    envState.TRUSTED_CLIENT_IP_HEADER = 'fly-client-ip';
    expect(getClientIp(new Headers({ 'fly-client-ip': '198.51.100.1' }))).toBe('198.51.100.1');
  });

  it('fails closed to 0.0.0.0 when unset, ignoring a client-supplied fly-client-ip header', () => {
    envState.TRUSTED_CLIENT_IP_HEADER = undefined;
    const headers = new Headers({ 'fly-client-ip': '203.0.113.21' });
    expect(getClientIp(headers)).toBe('0.0.0.0');
  });
});

describe('ipInAllowlist, consumes spoof-proof IP', () => {
  it('blocks (403) when the trusted header IP is outside the allowlist regardless of forged XFF', async () => {
    const res = await authenticate(
      makeReq({ 'x-forwarded-for': '10.0.0.5', 'fly-client-ip': '203.0.113.7' }, ['10.0.0.0/24']),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.response.status).toBe(403);
  });

  it('allows when the trusted header IP is inside the allowlist', async () => {
    const res = await authenticate(makeReq({ 'fly-client-ip': '10.0.0.5' }, ['10.0.0.0/24']));
    expect(res.ok).toBe(true);
  });
});

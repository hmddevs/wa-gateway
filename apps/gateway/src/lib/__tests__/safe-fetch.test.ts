/**
 * safe-fetch.ts, unit tests for `resolveSafeHost`.
 *
 * The range logic that actually stops SSRF (`isDisallowedV4`/`isDisallowedV6`)
 * is unexercised by the route-level tests, which mock `resolveSafeHost`
 * wholesale. These tests exercise it directly by mocking `node:dns/promises`'
 * `lookup` to return chosen addresses, so no real DNS resolution happens.
 * The `server-only` guard is neutralised by the vitest.config.ts alias.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- module mocks -----------------------------------------------------------

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(),
}));

// ---- imports after mocks -----------------------------------------------------

import { lookup as dnsLookup } from 'node:dns/promises';
import { resolveSafeHost } from '@/lib/safe-fetch';

const mockDnsLookup = dnsLookup as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------

function mockResolves(...addresses: Array<{ address: string; family: 4 | 6 }>): void {
  mockDnsLookup.mockResolvedValue(addresses);
}

beforeEach(() => {
  vi.clearAllMocks();
});

const URL_UNDER_TEST = 'https://example.test/media.jpg';

describe('resolveSafeHost, rejects disallowed ranges', () => {
  const disallowed: Array<[string, { address: string; family: 4 | 6 }]> = [
    ['IPv4 loopback (127.0.0.1)', { address: '127.0.0.1', family: 4 }],
    ['IPv4 RFC1918 10.x', { address: '10.1.2.3', family: 4 }],
    ['IPv4 RFC1918 192.168.x', { address: '192.168.1.1', family: 4 }],
    [
      'IPv4 link-local / cloud metadata (169.254.169.254)',
      { address: '169.254.169.254', family: 4 },
    ],
    ['IPv4 CGNAT (100.64.x)', { address: '100.64.0.1', family: 4 }],
    ['IPv4 unspecified (0.0.0.0)', { address: '0.0.0.0', family: 4 }],
    ['IPv6 loopback (::1)', { address: '::1', family: 6 }],
    ['IPv6 ULA fc00::/7', { address: 'fc00::1', family: 6 }],
    [
      'IPv6 IPv4-mapped metadata (::ffff:169.254.169.254)',
      { address: '::ffff:169.254.169.254', family: 6 },
    ],
    ['IPv6 IPv4-compatible loopback (::7f00:1)', { address: '::7f00:1', family: 6 }],
    [
      'IPv6 IPv4-mapped hex-word metadata (::ffff:a9fe:a9fe)',
      { address: '::ffff:a9fe:a9fe', family: 6 },
    ],
  ];

  for (const [label, addr] of disallowed) {
    it(`throws for ${label}`, async () => {
      mockResolves(addr);
      await expect(resolveSafeHost(URL_UNDER_TEST)).rejects.toThrow('URL_PRIVATE_IP');
    });
  }
});

describe('resolveSafeHost, allows legitimate public addresses', () => {
  it('resolves for a public IPv4 address', async () => {
    mockResolves({ address: '93.184.216.34', family: 4 });
    const result = await resolveSafeHost(URL_UNDER_TEST);
    expect(result.pinned.address).toBe('93.184.216.34');
  });

  it('resolves for a public IPv6 address', async () => {
    // Google public DNS IPv6, a real, ordinary public address, deliberately
    // chosen so its trailing 32 bits do not resemble a private IPv4 range,
    // and confirming the ::/96 and ::ffff:0:0/96-scoped embedded-IPv4 check
    // does not false-positive on it.
    mockResolves({ address: '2001:4860:4860::8888', family: 6 });
    const result = await resolveSafeHost(URL_UNDER_TEST);
    expect(result.pinned.address).toBe('2001:4860:4860::8888');
  });
});

describe('resolveSafeHost, protocol and record-set enforcement', () => {
  it('rejects http:// as URL_NOT_HTTPS before any DNS lookup', async () => {
    await expect(resolveSafeHost('http://example.test/media.jpg')).rejects.toThrow('URL_NOT_HTTPS');
    expect(mockDnsLookup).not.toHaveBeenCalled();
  });

  it('rejects when ANY resolved record is disallowed, even if others are public', async () => {
    mockResolves({ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 });
    await expect(resolveSafeHost(URL_UNDER_TEST)).rejects.toThrow('URL_PRIVATE_IP');
  });
});

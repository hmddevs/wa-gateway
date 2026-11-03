import { describe, it, expect } from 'vitest';
import { matchCidr, matchAnyCidr } from '../cidr';
import { CLOUDFLARE_IPV4_RANGES, CLOUDFLARE_IPV6_RANGES } from '../cloudflare-ips';

describe('matchCidr, IPv4', () => {
  it('matches an address inside the range', () => {
    expect(matchCidr('10.0.0.5', '10.0.0.0/24')).toBe(true);
  });
  it('rejects an address outside the range', () => {
    expect(matchCidr('10.0.1.5', '10.0.0.0/24')).toBe(false);
  });
  it('treats a bare address as /32', () => {
    expect(matchCidr('192.168.1.1', '192.168.1.1')).toBe(true);
    expect(matchCidr('192.168.1.2', '192.168.1.1')).toBe(false);
  });
  it('/0 matches everything in family', () => {
    expect(matchCidr('1.2.3.4', '0.0.0.0/0')).toBe(true);
  });
  it('fails closed on malformed input', () => {
    expect(matchCidr('not-an-ip', '10.0.0.0/24')).toBe(false);
    expect(matchCidr('10.0.0.5', 'garbage')).toBe(false);
    expect(matchCidr('10.0.0.5', '10.0.0.0/33')).toBe(false);
    expect(matchCidr('256.0.0.1', '10.0.0.0/24')).toBe(false);
  });
});

describe('matchCidr, IPv6', () => {
  it('matches inside a compressed range', () => {
    expect(matchCidr('2606:4700::1234', '2606:4700::/32')).toBe(true);
  });
  it('rejects outside the range', () => {
    expect(matchCidr('2400:cb00::1', '2606:4700::/32')).toBe(false);
  });
  it('does not cross families', () => {
    expect(matchCidr('1.2.3.4', '2606:4700::/32')).toBe(false);
    expect(matchCidr('2606:4700::1', '10.0.0.0/8')).toBe(false);
  });
  it('normalises IPv4-mapped IPv6 to IPv4', () => {
    expect(matchCidr('::ffff:10.0.0.5', '10.0.0.0/24')).toBe(true);
  });
});

describe('Cloudflare ranges', () => {
  it('recognises a known CF IPv4 edge address', () => {
    // 104.16.0.0/13 is a published Cloudflare range.
    expect(matchAnyCidr('104.16.5.5', CLOUDFLARE_IPV4_RANGES)).toBe(true);
  });
  it('recognises a known CF IPv6 edge address', () => {
    expect(matchAnyCidr('2606:4700::1', CLOUDFLARE_IPV6_RANGES)).toBe(true);
  });
  it('rejects a non-CF address', () => {
    expect(matchAnyCidr('8.8.8.8', [...CLOUDFLARE_IPV4_RANGES, ...CLOUDFLARE_IPV6_RANGES])).toBe(
      false,
    );
  });
});

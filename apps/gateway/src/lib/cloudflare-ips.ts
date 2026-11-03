/**
 * Cloudflare published edge IP ranges (IPv4 + IPv6).
 *
 * Source of truth: https://www.cloudflare.com/ips/ (also /ips-v4 and /ips-v6).
 * These ranges change rarely; pinned here so the IP-derivation path has no
 * network dependency at request time. Refresh when Cloudflare publishes a
 * change (the published list is the only authority, do not infer ranges).
 *
 * Used by `getClientIp` to decide whether a request genuinely arrived through
 * Cloudflare's proxy. We only honour `CF-Connecting-IP` when the immediate
 * upstream (the configured `TRUSTED_CLIENT_IP_HEADER`) is inside one of these
 * ranges; otherwise that header is just another spoofable string and is
 * ignored.
 *
 * Last reviewed: 2026-06.
 */

/** Cloudflare IPv4 ranges (CIDR). */
export const CLOUDFLARE_IPV4_RANGES: readonly string[] = [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
] as const;

/** Cloudflare IPv6 ranges (CIDR). */
export const CLOUDFLARE_IPV6_RANGES: readonly string[] = [
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32',
] as const;

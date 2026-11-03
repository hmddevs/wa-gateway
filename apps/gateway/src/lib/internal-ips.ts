/**
 * Internal address space for same-host-provider private networking.
 *
 * If your gateway host offers a private network for worker→gateway
 * callbacks (e.g. a unique-local IPv6 block such as `fdaa::/16`), requests
 * arriving on that network are infrastructure-internal and never transit
 * your edge proxy, so the origin lock must treat them as always-trusted.
 * Adjust `INTERNAL_RANGES` to match your own host's private network, or
 * leave only loopback if you do not use one.
 *
 * Fail-closed warning: this list backs `ENFORCE_CLOUDFLARE_ORIGIN`. Turning
 * that flag on without a proxy in front of your host that actually supplies
 * a trusted peer-IP header will reject every request, including your own.
 *
 * Edge-safe: a plain string array, consumed by the BigInt CIDR matcher.
 */

/** Trusted private/internal ranges (CIDR). */
export const INTERNAL_RANGES: readonly string[] = [
  // Example: Fly.io's 6PN unique-local IPv6 space. Replace with your own
  // host's private network range, or remove if you do not have one.
  'fdaa::/16',
  // Loopback, in case a probe ever connects over it on the origin itself.
  '::1/128',
  '127.0.0.0/8',
] as const;

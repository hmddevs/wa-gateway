/**
 * Minimal IPv4 + IPv6 CIDR matching, BigInt-based, no dependencies.
 *
 * Used for two trust-boundary decisions:
 *   - whether a hop IP falls inside a Cloudflare edge range (see cloudflare-ips)
 *   - whether a client IP satisfies a per-key IP allowlist
 *
 * Fail-closed: any malformed input (bad IP, bad CIDR, family mismatch) returns
 * `false` rather than throwing. A `/0` range matches every address of the same
 * family. IPv4-mapped IPv6 addresses (`::ffff:1.2.3.4`) are normalised to their
 * IPv4 form before comparison so a v4 client behind a v6-aware stack still
 * matches a v4 range.
 */

/** Parse an IPv4 dotted-quad to a 32-bit BigInt, or null if malformed. */
function parseIpv4(ip: string): bigint | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let acc = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n < 0 || n > 255) return null;
    acc = (acc << 8n) | BigInt(n);
  }
  return acc;
}

/**
 * Parse an IPv6 address to a 128-bit BigInt, or null if malformed. Handles
 * `::` compression and embedded IPv4 tails (`::ffff:1.2.3.4`).
 */
function parseIpv6(ip: string): bigint | null {
  if (ip.indexOf(':') === -1) return null;
  // Split off an embedded IPv4 tail, if present.
  let head = ip;
  let v4Tail: bigint | null = null;
  const lastColon = ip.lastIndexOf(':');
  const tail = ip.slice(lastColon + 1);
  if (tail.indexOf('.') !== -1) {
    v4Tail = parseIpv4(tail);
    if (v4Tail === null) return null;
    head = ip.slice(0, lastColon + 1) + '0:0';
  }

  const halves = head.split('::');
  if (halves.length > 2) return null;

  const expand = (segs: string): bigint[] => {
    if (segs === '') return [];
    return segs.split(':').map((s) => {
      if (!/^[0-9a-fA-F]{1,4}$/.test(s)) return -1n;
      return BigInt(parseInt(s, 16));
    });
  };

  const left = expand(halves[0] ?? '');
  const right = halves.length === 2 ? expand(halves[1] ?? '') : [];
  if (left.includes(-1n) || right.includes(-1n)) return null;

  let groups: bigint[];
  if (halves.length === 2) {
    const fill = 8 - left.length - right.length;
    if (fill < 0) return null;
    groups = [...left, ...new Array<bigint>(fill).fill(0n), ...right];
  } else {
    groups = left;
  }
  if (groups.length !== 8) return null;

  let acc = 0n;
  for (const g of groups) acc = (acc << 16n) | g;

  if (v4Tail !== null) {
    // Replace the final 32 bits with the embedded IPv4 value.
    acc = (acc & ~0xffffffffn) | v4Tail;
  }
  return acc;
}

interface ParsedIp {
  value: bigint;
  family: 4 | 6;
}

/** Parse an IP of either family, normalising IPv4-mapped IPv6 to IPv4. */
function parseIp(ip: string): ParsedIp | null {
  const trimmed = ip.trim();
  if (trimmed.indexOf(':') === -1) {
    const v4 = parseIpv4(trimmed);
    return v4 === null ? null : { value: v4, family: 4 };
  }
  const v6 = parseIpv6(trimmed);
  if (v6 === null) return null;
  // Normalise an IPv4-mapped address (::ffff:0:0/96) down to plain IPv4.
  const mappedPrefix = 0xffffn << 32n;
  if (v6 >> 32n === mappedPrefix >> 32n && (v6 & ~0xffffffffn) === mappedPrefix) {
    return { value: v6 & 0xffffffffn, family: 4 };
  }
  return { value: v6, family: 6 };
}

/**
 * Returns true when `ip` is inside the CIDR `cidr`. Both families supported.
 * Fail-closed on any malformed or mismatched-family input.
 */
export function matchCidr(ip: string, cidr: string): boolean {
  const slash = cidr.indexOf('/');
  const range = slash === -1 ? cidr : cidr.slice(0, slash);
  const bitsStr = slash === -1 ? '' : cidr.slice(slash + 1);

  const addr = parseIp(ip);
  const net = parseIp(range);
  if (!addr || !net) return false;
  if (addr.family !== net.family) return false;

  const width = net.family === 4 ? 32 : 128;
  const bits = bitsStr === '' ? width : Number(bitsStr);
  if (!Number.isInteger(bits) || bits < 0 || bits > width) return false;
  if (bits === 0) return true;

  const shift = BigInt(width - bits);
  const mask = (~0n << shift) & ((1n << BigInt(width)) - 1n);
  return (addr.value & mask) === (net.value & mask);
}

/** Returns true when `ip` falls inside any of the supplied CIDR ranges. */
export function matchAnyCidr(ip: string, cidrs: readonly string[]): boolean {
  return cidrs.some((c) => matchCidr(ip, c));
}

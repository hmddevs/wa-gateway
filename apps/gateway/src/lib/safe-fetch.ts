/**
 * SSRF-safe URL fetcher.
 *
 * Rules:
 *   - Only https.
 *   - No redirects followed.
 *   - 10s total timeout.
 *   - 10 MiB max body.
 *   - DNS resolve the host and reject if ANY resolved address falls in a
 *     disallowed range (RFC1918, loopback, link-local, CGNAT, multicast,
 *     broadcast, IPv4-mapped IPv6, IPv6 unique-local/link-local/loopback).
 *
 * We resolve ourselves and then connect via `lookup` that forces the
 * pre-validated address to prevent DNS-rebinding attacks.
 */
import 'server-only';
import { lookup as dnsLookup } from 'node:dns/promises';
import { request } from 'node:https';
import { URL } from 'node:url';

const DISALLOWED_V4: Array<[number, number]> = [
  [ipv4('10.0.0.0'), 8],
  [ipv4('172.16.0.0'), 12],
  [ipv4('192.168.0.0'), 16],
  [ipv4('127.0.0.0'), 8],
  [ipv4('169.254.0.0'), 16],
  [ipv4('100.64.0.0'), 10],
  [ipv4('0.0.0.0'), 8],
  [ipv4('224.0.0.0'), 4],
  [ipv4('240.0.0.0'), 4],
];

function ipv4(s: string): number {
  const p = s.split('.').map(Number);
  return ((p[0]! << 24) >>> 0) + (p[1]! << 16) + (p[2]! << 8) + p[3]!;
}

function isDisallowedV4(address: string): boolean {
  const long = ipv4(address);
  return DISALLOWED_V4.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : ((1 << bits) - 1) << (32 - bits);
    return (long & mask) === (base & mask);
  });
}

/** Fully expand a valid IPv6 address (handles `::` compression) into 8 hex words. */
function expandV6(address: string): string[] | null {
  const [head, tail] = address.split('::');
  if (tail === undefined) {
    const words = address.split(':');
    return words.length === 8 ? words : null;
  }
  const headWords = !head ? [] : head.split(':');
  const tailWords = tail === '' ? [] : tail.split(':');
  const missing = 8 - headWords.length - tailWords.length;
  if (missing < 0) return null;
  return [...headWords, ...Array(missing).fill('0'), ...tailWords];
}

/**
 * Extract the IPv4 address embedded in the last 32 bits of a fully-expanded
 * IPv6 address, but ONLY when the leading 96 bits match a recognised
 * IPv4-in-IPv6 prefix, `::/96` (IPv4-compatible, e.g. `::7f00:1` =
 * 127.0.0.1) or `::ffff:0:0/96` (IPv4-mapped, hex-word form, e.g.
 * `::ffff:a9fe:a9fe` = 169.254.169.254). Restricting to these prefixes (as
 * opposed to reading the last 32 bits of any address) avoids false-positives
 * on ordinary public IPv6 addresses whose low bits happen to resemble a
 * private IPv4 octet pattern.
 */
function embeddedV4(words: string[]): string | null {
  const first6ZeroPad = words.slice(0, 5).every((w) => parseInt(w, 16) === 0);
  if (!first6ZeroPad) return null;
  const word5 = parseInt(words[5]!, 16);
  // word5 === 0 → IPv4-compatible (::/96); word5 === 0xffff → IPv4-mapped
  // hex-word form (::ffff:0:0/96, the dotted form is handled separately).
  if (word5 !== 0 && word5 !== 0xffff) return null;
  const hi = parseInt(words[6]!, 16);
  const lo = parseInt(words[7]!, 16);
  if (Number.isNaN(hi) || Number.isNaN(lo)) return null;
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join('.');
}

function isDisallowedV6(address: string): boolean {
  const a = address.toLowerCase();
  if (a === '::1') return true;
  if (a === '::' || a === '::0') return true;
  if (a.startsWith('fe80:')) return true; // link-local
  if (a.startsWith('fc') || a.startsWith('fd')) return true; // unique-local
  if (a.startsWith('ff')) return true; // multicast
  if (a.startsWith('::ffff:')) {
    // IPv4-mapped, dotted form (`::ffff:169.254.169.254`).
    const v4 = a.slice('::ffff:'.length);
    if (v4.includes('.')) return isDisallowedV4(v4);
    // Hex-word form (`::ffff:a9fe:a9fe`) falls through to the embedded-IPv4
    // check below via the general expansion path.
  }

  // IPv4-compatible (`::x.x.x.x` / `::7f00:1`) and IPv4-mapped hex-word
  // (`::ffff:a9fe:a9fe`) forms: reject if the embedded IPv4 is disallowed.
  // Scoped to the `::/96` and `::ffff:0:0/96` prefixes only, so ordinary
  // public IPv6 addresses are never affected.
  const words = expandV6(a);
  if (words) {
    const embedded = embeddedV4(words);
    if (embedded && isDisallowedV4(embedded)) return true;
  }

  return false;
}

/**
 * Resolve a URL's host, reject HTTPS-not-set / private-IP / link-local / etc.,
 * and return the pinned address. Use before issuing any HTTP request to a
 * caller-supplied URL (webhook destinations, image fetches, etc.).
 */
export async function resolveSafeHost(urlStr: string): Promise<{
  url: URL;
  pinned: { address: string; family: number };
}> {
  const url = new URL(urlStr);
  if (url.protocol !== 'https:') throw new Error('URL_NOT_HTTPS');
  if (!url.hostname) throw new Error('URL_NO_HOST');

  const resolved = await dnsLookup(url.hostname, { all: true });
  if (resolved.length === 0) throw new Error('URL_DNS_EMPTY');
  for (const r of resolved) {
    if (r.family === 4 && isDisallowedV4(r.address)) throw new Error('URL_PRIVATE_IP');
    if (r.family === 6 && isDisallowedV6(r.address)) throw new Error('URL_PRIVATE_IP');
  }
  return { url, pinned: resolved[0]! };
}

export async function safeFetch(urlStr: string): Promise<{
  body: Buffer;
  contentType: string;
  status: number;
}> {
  const { url, pinned } = await resolveSafeHost(urlStr);
  const MAX = 10 * 1024 * 1024;

  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: 'GET',
        headers: { Host: url.hostname, 'User-Agent': 'hmd-wa-gateway/1.0' },
        lookup: (_host, _opts, cb) => cb(null, pinned.address, pinned.family),
        timeout: 10_000,
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400) {
          res.resume();
          reject(new Error('URL_REDIRECT_NOT_ALLOWED'));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > MAX) {
            res.destroy(new Error('URL_TOO_LARGE'));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () =>
          resolve({
            body: Buffer.concat(chunks),
            contentType: String(res.headers['content-type'] ?? 'application/octet-stream'),
            status: res.statusCode ?? 0,
          }),
        );
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error('URL_TIMEOUT')));
    req.on('error', reject);
    req.end();
  });
}

/**
 * SSRF-safe POST. Same DNS-pin + range checks as safeFetch but allows custom
 * method/body/headers (used for webhook delivery). Resolves with the response
 * status, response headers, and the response body buffer (truncated to 64 KiB, * we only ever surface a snippet for diagnostics).
 */
export async function safePost(
  urlStr: string,
  body: string,
  headers: Record<string, string>,
  options: { timeoutMs: number },
): Promise<{ status: number; bodySnippet: string }> {
  const { url, pinned } = await resolveSafeHost(urlStr);
  const MAX = 64 * 1024;

  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: 'POST',
        headers: { ...headers, Host: url.hostname, 'Content-Length': Buffer.byteLength(body) },
        lookup: (_host, _opts, cb) => cb(null, pinned.address, pinned.family),
        timeout: options.timeoutMs,
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400) {
          res.resume();
          reject(new Error('URL_REDIRECT_NOT_ALLOWED'));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          if (size >= MAX) return;
          const remaining = MAX - size;
          chunks.push(c.subarray(0, remaining));
          size += Math.min(c.length, remaining);
        });
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            bodySnippet: Buffer.concat(chunks).toString('utf8'),
          }),
        );
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error('URL_TIMEOUT')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

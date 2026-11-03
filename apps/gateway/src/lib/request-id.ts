/**
 * Request ID helpers. Every response carries `X-Request-Id`. The middleware
 * assigns one if the inbound request has none (or one that looks untrusted).
 */
// Use Web Crypto (globalThis.crypto.randomUUID) so this works on Edge,
// Node 20+, and browsers without pulling in `node:crypto`.

const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

export function mintRequestId(incoming?: string | null): string {
  if (incoming && REQUEST_ID_RE.test(incoming)) return incoming;
  return `req_${globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

export const REQUEST_ID_HEADER = 'x-request-id';

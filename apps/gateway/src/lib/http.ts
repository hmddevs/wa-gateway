/**
 * Shared HTTP helpers: consistent error shape + JSON responses with
 * security headers and the ambient `X-Request-Id`.
 */
import 'server-only';
import type { ErrorCode } from '@hmddevs/protocol';

const jsonHeaders = (requestId: string): HeadersInit => ({
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Request-Id': requestId,
});

export function errorResponse(
  status: number,
  code: ErrorCode,
  message: string,
  requestId: string,
  /** Extra headers, e.g. `Retry-After` on a capacity 429. */
  extraHeaders?: Record<string, string>,
): Response {
  const body = { error: message, code, requestId };
  const headers = new Headers(jsonHeaders(requestId));
  for (const [k, v] of Object.entries(extraHeaders ?? {})) headers.set(k, v);
  return new Response(JSON.stringify(body), { status, headers });
}

export function jsonResponse(status: number, payload: unknown, requestId: string): Response {
  return new Response(JSON.stringify(payload), { status, headers: jsonHeaders(requestId) });
}

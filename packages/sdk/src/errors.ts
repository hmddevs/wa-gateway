/**
 * `HmdWAError`, every failure surfaced by the SDK is an instance of this.
 *
 * `code` is either a gateway-issued `ErrorCode` (see `@hmddevs/protocol`) or
 * one of the client-side codes declared in `CLIENT_ERROR_CODES` below. Use
 * `HMD_WA_ERROR_CODES` to compare against either family without re-typing
 * literals.
 */
import { ErrorCodes } from '@hmddevs/protocol';

/** Codes raised purely on the client (no HTTP response, or a malformed one). */
export const CLIENT_ERROR_CODES = {
  NETWORK_ERROR: 'NETWORK_ERROR',
  TIMEOUT: 'TIMEOUT',
  ABORTED: 'ABORTED',
  INVALID_RESPONSE: 'INVALID_RESPONSE',
  CONFIG_ERROR: 'CONFIG_ERROR',
} as const;

/** Combined code surface, gateway error envelope codes plus client-side codes. */
export const HMD_WA_ERROR_CODES = {
  ...ErrorCodes,
  ...CLIENT_ERROR_CODES,
} as const;

export type HmdWAErrorCode =
  | (typeof HMD_WA_ERROR_CODES)[keyof typeof HMD_WA_ERROR_CODES]
  | (string & {});

/** HTTP statuses that the SDK treats as worth retrying (subject to `maxRetries`). */
const RETRYABLE_HTTP_STATUSES = new Set<number>([408, 429, 500, 502, 503, 504]);

export class HmdWAError extends Error {
  readonly code: HmdWAErrorCode;
  readonly httpStatus?: number;
  readonly requestId?: string;
  readonly retryable: boolean;
  /** Raw response body if the gateway returned a non-JSON or unexpected shape. */
  readonly rawBody?: string;

  constructor(opts: {
    code: HmdWAErrorCode;
    message: string;
    httpStatus?: number;
    requestId?: string;
    retryable?: boolean;
    rawBody?: string;
    cause?: unknown;
  }) {
    super(opts.message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'HmdWAError';
    this.code = opts.code;
    this.httpStatus = opts.httpStatus;
    this.requestId = opts.requestId;
    this.rawBody = opts.rawBody;
    this.retryable = opts.retryable ?? defaultRetryable(opts.code, opts.httpStatus);
  }

  override toString(): string {
    const parts = [`${this.name} [${this.code}]: ${this.message}`];
    if (this.httpStatus !== undefined) parts.push(`http=${this.httpStatus}`);
    if (this.requestId) parts.push(`requestId=${this.requestId}`);
    return parts.join(' ');
  }

  /**
   * Build an `HmdWAError` from a non-2xx HTTP response. Accepts both the flat
   * envelope (`{ error, code, requestId }`, what the gateway actually emits)
   * and the nested envelope (`{ error: { code, message, requestId } }`, * declared in the protocol's `ErrorResponseSchema`). Falls back to a
   * synthetic envelope when the body is missing or malformed.
   */
  static fromResponse(httpStatus: number, body: unknown, rawBody?: string): HmdWAError {
    const parsed = parseErrorEnvelope(body);
    return new HmdWAError({
      code: parsed.code ?? fallbackCodeFromStatus(httpStatus),
      message: parsed.message ?? `Gateway returned HTTP ${httpStatus}`,
      httpStatus,
      requestId: parsed.requestId,
      retryable: RETRYABLE_HTTP_STATUSES.has(httpStatus),
      rawBody,
    });
  }
}

function defaultRetryable(code: HmdWAErrorCode, httpStatus: number | undefined): boolean {
  if (httpStatus !== undefined) return RETRYABLE_HTTP_STATUSES.has(httpStatus);
  return code === CLIENT_ERROR_CODES.NETWORK_ERROR || code === CLIENT_ERROR_CODES.TIMEOUT;
}

function fallbackCodeFromStatus(httpStatus: number): HmdWAErrorCode {
  if (httpStatus === 401 || httpStatus === 403) return ErrorCodes.UNAUTHORIZED;
  if (httpStatus === 404) return ErrorCodes.INVALID_BODY;
  if (httpStatus === 409) return ErrorCodes.IDEMPOTENCY_CONFLICT;
  if (httpStatus === 413) return ErrorCodes.PAYLOAD_TOO_LARGE;
  if (httpStatus === 415) return ErrorCodes.UNSUPPORTED_MEDIA_TYPE;
  if (httpStatus === 429) return ErrorCodes.RATE_LIMITED;
  if (httpStatus === 503) return ErrorCodes.WORKER_UNAVAILABLE;
  if (httpStatus >= 500) return ErrorCodes.INTERNAL;
  return ErrorCodes.INVALID_BODY;
}

interface ParsedEnvelope {
  code?: string;
  message?: string;
  requestId?: string;
}

function parseErrorEnvelope(body: unknown): ParsedEnvelope {
  if (!body || typeof body !== 'object') return {};
  const obj = body as Record<string, unknown>;

  // Flat shape: { error, code, requestId }, what the gateway actually emits.
  if (typeof obj.code === 'string') {
    return {
      code: obj.code,
      message: typeof obj.error === 'string' ? obj.error : undefined,
      requestId: typeof obj.requestId === 'string' ? obj.requestId : undefined,
    };
  }

  // Nested shape: { error: { code, message, requestId } }, declared envelope.
  if (obj.error && typeof obj.error === 'object') {
    const inner = obj.error as Record<string, unknown>;
    return {
      code: typeof inner.code === 'string' ? inner.code : undefined,
      message: typeof inner.message === 'string' ? inner.message : undefined,
      requestId: typeof inner.requestId === 'string' ? inner.requestId : undefined,
    };
  }

  return {};
}

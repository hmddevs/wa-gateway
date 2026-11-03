/**
 * Canonical error codes. No string matching, callers compare against these.
 * Every error returned by the gateway API carries one of these codes.
 */
export const ErrorCodes = {
  // 400
  INVALID_PHONE: 'INVALID_PHONE',
  INVALID_CONTENT: 'INVALID_CONTENT',
  INVALID_BODY: 'INVALID_BODY',
  // 401 / 403
  UNAUTHORIZED: 'UNAUTHORIZED',
  SCOPE_DENIED: 'SCOPE_DENIED',
  IP_NOT_ALLOWED: 'IP_NOT_ALLOWED',
  WEBAUTHN_REQUIRED: 'WEBAUTHN_REQUIRED',
  // 404
  RECIPIENT_NOT_FOUND: 'RECIPIENT_NOT_FOUND',
  NOT_FOUND: 'NOT_FOUND',
  // 422
  INVALID_PRESENCE_STATE: 'INVALID_PRESENCE_STATE',
  INVALID_REACTION: 'INVALID_REACTION',
  OPTED_OUT: 'OPTED_OUT',
  SEND_AT_PAST: 'SEND_AT_PAST',
  // 409
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  // 413 / 415
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  UNSUPPORTED_MEDIA_TYPE: 'UNSUPPORTED_MEDIA_TYPE',
  // 429
  RATE_LIMITED: 'RATE_LIMITED',
  VELOCITY_EXCEEDED: 'VELOCITY_EXCEEDED',
  NEW_RECIPIENT_BLOCKED: 'NEW_RECIPIENT_BLOCKED',
  // 503
  WORKER_UNAVAILABLE: 'WORKER_UNAVAILABLE',
  MAINTENANCE: 'MAINTENANCE',
  // 500
  INTERNAL: 'INTERNAL',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

/** Flat JSON error body returned by every gateway endpoint on failure. */
export interface ApiErrorBody {
  error: string;
  code: ErrorCode;
  requestId: string;
  details?: Record<string, unknown>;
}

/**
 * Lightweight ApiError used by helper modules that aren't bound to a specific
 * route handler. Route entry points convert these into HTTP responses via
 * `errorResponse(status, code, message, requestId)` from `./http`.
 */
import 'server-only';
import type { ErrorCode } from '@hmddevs/protocol';

export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  constructor(status: number, code: ErrorCode, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/**
 * HmdWAError, fromResponse shape handling and retryable inference.
 */
import { describe, it, expect } from 'vitest';
import { HmdWAError } from '../src/index.js';

describe('HmdWAError.fromResponse, flat envelope', () => {
  it('extracts code, message, and requestId from the flat gateway envelope', () => {
    const err = HmdWAError.fromResponse(429, {
      error: 'Rate limited',
      code: 'RATE_LIMITED',
      requestId: 'req_x',
    });
    expect(err).toBeInstanceOf(HmdWAError);
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.message).toBe('Rate limited');
    expect(err.requestId).toBe('req_x');
    expect(err.httpStatus).toBe(429);
  });
});

describe('HmdWAError.fromResponse, nested envelope', () => {
  it('extracts fields from the nested { error: { code, message, requestId } } shape', () => {
    const err = HmdWAError.fromResponse(503, {
      error: { code: 'WORKER_UNAVAILABLE', message: 'Worker offline', requestId: 'req_y' },
    });
    expect(err.code).toBe('WORKER_UNAVAILABLE');
    expect(err.message).toBe('Worker offline');
    expect(err.requestId).toBe('req_y');
    expect(err.httpStatus).toBe(503);
  });
});

describe('HmdWAError, retryable inference', () => {
  it('marks 429 as retryable', () => {
    const err = HmdWAError.fromResponse(429, {
      error: 'Rate limited',
      code: 'RATE_LIMITED',
      requestId: 'r1',
    });
    expect(err.retryable).toBe(true);
  });

  it('marks 503 as retryable', () => {
    const err = HmdWAError.fromResponse(503, {
      error: 'Unavailable',
      code: 'WORKER_UNAVAILABLE',
      requestId: 'r2',
    });
    expect(err.retryable).toBe(true);
  });

  it('marks 400 as non-retryable', () => {
    const err = HmdWAError.fromResponse(400, {
      error: 'Bad body',
      code: 'INVALID_BODY',
      requestId: 'r3',
    });
    expect(err.retryable).toBe(false);
  });

  it('marks 401 as non-retryable', () => {
    const err = HmdWAError.fromResponse(401, {
      error: 'Unauthorized',
      code: 'UNAUTHORIZED',
      requestId: 'r4',
    });
    expect(err.retryable).toBe(false);
  });

  it('marks a TIMEOUT code as retryable when constructed directly', () => {
    const err = new HmdWAError({ code: 'TIMEOUT', message: 'timed out' });
    expect(err.retryable).toBe(true);
  });

  it('marks a NETWORK_ERROR code as retryable when constructed directly', () => {
    const err = new HmdWAError({ code: 'NETWORK_ERROR', message: 'connect refused' });
    expect(err.retryable).toBe(true);
  });
});

describe('HmdWAError.fromResponse, missing body', () => {
  it('falls back to a synthetic code and message when body is empty', () => {
    const err = HmdWAError.fromResponse(500, null);
    expect(err.code).toBeTruthy();
    expect(err.message).toContain('500');
    expect(err.httpStatus).toBe(500);
  });
});

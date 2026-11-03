/**
 * SDK client, retry policy.
 *
 * Uses Retry-After: 0 and Math.random stubbed to 0 so exponential backoff
 * produces 0 ms delays. This lets us use real timers without slow tests,
 * avoiding the Vitest 2.1 unhandled-rejection noise from fake timers
 * interacting with the async retry loop.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { hmdWA, HmdWAError } from '../src/index.js';
import type { SendMessageResponse } from '@hmddevs/protocol';

const API_KEY = 'retry-test-key';
const BASE_URL = 'https://wa.retry.test';

function makeResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) => headers[name.toLowerCase()] ?? null,
    },
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

describe('client.retry, 429 → 503 → 202 sequence', () => {
  beforeEach(() => {
    // Stub Math.random to 0 so jitter is 0 ms. Combined with Retry-After: 0
    // on the 429, all backoffs resolve immediately with real timers.
    vi.spyOn(Math, 'random').mockReturnValue(0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('succeeds after two retryable failures, preserving idempotencyKey in body on all three attempts', async () => {
    const successBody: SendMessageResponse = { messageId: 'msg-retry-ok', status: 'queued' };
    const callCount = { n: 0 };
    const idempotencyKeys: (string | null)[] = [];

    const mockFetch = vi.fn((_url: string, init: RequestInit) => {
      const parsed = JSON.parse(init.body as string) as { idempotencyKey?: string };
      idempotencyKeys.push(parsed.idempotencyKey ?? null);
      callCount.n += 1;
      if (callCount.n === 1) {
        // Retry-After: 0 → 0 ms delay, so the test is fast.
        return Promise.resolve(
          makeResponse(
            429,
            { error: 'Rate limited', code: 'RATE_LIMITED' },
            { 'retry-after': '0' },
          ),
        );
      }
      if (callCount.n === 2) {
        return Promise.resolve(
          makeResponse(503, { error: 'Unavailable', code: 'WORKER_UNAVAILABLE' }),
        );
      }
      return Promise.resolve(makeResponse(202, successBody));
    }) as unknown as typeof fetch;

    const client = hmdWA({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      fetch: mockFetch,
      maxRetries: 3,
    });

    const result = await client.send(
      {
        to: '+447700900123',
        channel: 'transactional' as const,
        body: { kind: 'text' as const, text: 'retry test' },
      },
      { idempotencyKey: 'abc-12345' },
    );

    expect(callCount.n).toBe(3);
    expect(result.messageId).toBe('msg-retry-ok');
    // All three calls must carry the same idempotency key.
    expect(idempotencyKeys).toEqual(['abc-12345', 'abc-12345', 'abc-12345']);
  });
});

describe('client.retry, non-retryable 4xx', () => {
  it('throws HmdWAError immediately on 400 without retrying', async () => {
    const callCount = { n: 0 };
    const mockFetch = vi.fn(() => {
      callCount.n += 1;
      return Promise.resolve(makeResponse(400, { error: 'Bad input', code: 'INVALID_BODY' }));
    }) as unknown as typeof fetch;

    const client = hmdWA({ apiKey: API_KEY, baseUrl: BASE_URL, fetch: mockFetch, maxRetries: 3 });

    await expect(
      client.send({
        to: '+447700900123',
        channel: 'transactional' as const,
        body: { kind: 'text' as const, text: 'bad' },
      }),
    ).rejects.toBeInstanceOf(HmdWAError);

    expect(callCount.n).toBe(1);
  });
});

describe('client.retry, maxRetries: 0', () => {
  it('throws immediately on 503 when maxRetries is 0', async () => {
    const callCount = { n: 0 };
    const mockFetch = vi.fn(() => {
      callCount.n += 1;
      return Promise.resolve(
        makeResponse(503, { error: 'Unavailable', code: 'WORKER_UNAVAILABLE' }),
      );
    }) as unknown as typeof fetch;

    const client = hmdWA({ apiKey: API_KEY, baseUrl: BASE_URL, fetch: mockFetch, maxRetries: 0 });

    await expect(
      client.send({
        to: '+447700900123',
        channel: 'transactional' as const,
        body: { kind: 'text' as const, text: 'no retry' },
      }),
    ).rejects.toBeInstanceOf(HmdWAError);

    expect(callCount.n).toBe(1);
  });
});

describe('client.retry, network errors', () => {
  beforeEach(() => {
    // Zero jitter so backoff is ~250 ms * 2^attempt, acceptable for 2 retries.
    // A real-timer approach; no fake timers, no unhandled rejection noise.
    vi.spyOn(Math, 'random').mockReturnValue(0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('retries on network error up to maxRetries, then throws HmdWAError', async () => {
    const callCount = { n: 0 };
    const mockFetch = vi.fn(() => {
      callCount.n += 1;
      return Promise.reject(new TypeError('fetch failed'));
    }) as unknown as typeof fetch;

    const client = hmdWA({ apiKey: API_KEY, baseUrl: BASE_URL, fetch: mockFetch, maxRetries: 2 });

    await expect(
      client.send({
        to: '+447700900123',
        channel: 'transactional' as const,
        body: { kind: 'text' as const, text: 'net fail' },
      }),
    ).rejects.toBeInstanceOf(HmdWAError);

    // 1 initial + 2 retries = 3 total calls.
    expect(callCount.n).toBe(3);
  }, 10_000); // generous timeout for real backoff (250+500 ms ≈ 750 ms total)
});

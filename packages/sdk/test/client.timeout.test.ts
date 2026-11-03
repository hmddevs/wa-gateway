/**
 * SDK client, timeout behaviour.
 *
 * Uses a genuinely short timeoutMs (1 ms) with a real hanging fetch so the
 * AbortController fires immediately without fake timers. This avoids the
 * unhandled-rejection noise that Vitest 2.1 produces when fake timers fire
 * setTimeout callbacks outside the current microtask chain.
 */
import { describe, it, expect } from 'vitest';
import { hmdWA, HmdWAError } from '../src/index.js';

const API_KEY = 'timeout-test-key';
const BASE_URL = 'https://wa.timeout.test';

describe('client, timeout', () => {
  it('throws HmdWAError with TIMEOUT code when fetch never resolves within timeoutMs', async () => {
    // fetch hangs until the abort signal fires, then rejects with AbortError.
    const mockFetch = (_url: string, init: RequestInit): Promise<Response> => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init.signal as AbortSignal | undefined;
        if (signal) {
          const handler = (): void => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          };
          if (signal.aborted) {
            handler();
          } else {
            signal.addEventListener('abort', handler, { once: true });
          }
        }
      });
    };

    // timeoutMs: 1 means the AbortController fires after 1 ms, real timer,
    // no fake-timer complexity, completes in <20 ms total.
    const client = hmdWA({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      fetch: mockFetch as typeof fetch,
      timeoutMs: 1,
      maxRetries: 0,
    });

    const err = await client
      .send({
        to: '+447700900123',
        channel: 'transactional' as const,
        body: { kind: 'text' as const, text: 'will timeout' },
      })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HmdWAError);
    expect((err as HmdWAError).code).toBe('TIMEOUT');
  });
});

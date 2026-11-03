/**
 * SDK client.sendAndConfirm, unit tests.
 *
 * Mock strategy: inject a controlled `fetch` function; no real network.
 * Follows the patterns in `client.send.test.ts` and `client.retry.test.ts`.
 * Fake timers are NOT used, see `client.timeout.test.ts` for the documented
 * rationale (Vitest 2.1 unhandled-rejection noise with fake timer / async
 * interactions). The per-attempt-extended-timeout case uses short real timers.
 */
import { describe, it, expect, vi } from 'vitest';
import { hmdWA, HmdWAError } from '../src/index.js';
import type { SendMessageResponse } from '@hmddevs/protocol';

const API_KEY = 'test-api-key-confirm';
const BASE_URL = 'https://wa.test.example';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function makeResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

function makeMockFetch(status: number, body: unknown): typeof fetch {
  return vi.fn().mockResolvedValue(makeResponse(status, body)) as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------
// Forwarding fields into request body
// ---------------------------------------------------------------------------

describe('sendAndConfirm, request body fields', () => {
  it('forwards confirm: true and confirmTimeoutMs in the request body', async () => {
    const responseBody: SendMessageResponse = { messageId: 'msg-confirm-1', status: 'sent' };
    const mockFetch = makeMockFetch(200, responseBody);
    const client = hmdWA({ apiKey: API_KEY, baseUrl: BASE_URL, fetch: mockFetch });

    await client.sendAndConfirm(
      { to: '+447700900123', channel: 'transactional', body: { kind: 'text', text: 'hi' } },
      { confirmTimeoutMs: 3000 },
    );

    const [, init] = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const parsed = JSON.parse(init.body as string) as {
      confirm?: boolean;
      confirmTimeoutMs?: number;
    };
    expect(parsed.confirm).toBe(true);
    expect(parsed.confirmTimeoutMs).toBe(3000);
  });

  it('defaults confirmTimeoutMs to 5000 when opts.confirmTimeoutMs is omitted', async () => {
    const responseBody: SendMessageResponse = { messageId: 'msg-confirm-2', status: 'sent' };
    const mockFetch = makeMockFetch(200, responseBody);
    const client = hmdWA({ apiKey: API_KEY, baseUrl: BASE_URL, fetch: mockFetch });

    await client.sendAndConfirm({
      to: '+447700900123',
      channel: 'transactional',
      body: { kind: 'text', text: 'default timeout' },
    });

    const [, init] = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const parsed = JSON.parse(init.body as string) as { confirmTimeoutMs?: number };
    expect(parsed.confirmTimeoutMs).toBe(5000);
  });

  it('overrides req.confirm and req.confirmTimeoutMs from opts', async () => {
    const responseBody: SendMessageResponse = { messageId: 'msg-confirm-3', status: 'sent' };
    const mockFetch = makeMockFetch(200, responseBody);
    const client = hmdWA({ apiKey: API_KEY, baseUrl: BASE_URL, fetch: mockFetch });

    await client.sendAndConfirm(
      {
        to: '+447700900123',
        channel: 'transactional',
        body: { kind: 'text', text: 'override' },
        confirm: false,
        confirmTimeoutMs: 9999,
      },
      { confirmTimeoutMs: 1000 },
    );

    const [, init] = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const parsed = JSON.parse(init.body as string) as {
      confirm?: boolean;
      confirmTimeoutMs?: number;
    };
    expect(parsed.confirm).toBe(true);
    expect(parsed.confirmTimeoutMs).toBe(1000);
  });
});

// ---------------------------------------------------------------------------
// Pre-network validation, confirmTimeoutMs bounds
// ---------------------------------------------------------------------------

describe('sendAndConfirm, confirmTimeoutMs validation', () => {
  it('rejects confirmTimeoutMs < 300 with CONFIG_ERROR before any fetch call', async () => {
    const mockFetch = vi.fn() as unknown as typeof fetch;
    const client = hmdWA({ apiKey: API_KEY, baseUrl: BASE_URL, fetch: mockFetch });

    const err = await client
      .sendAndConfirm(
        { to: '+447700900123', channel: 'transactional', body: { kind: 'text', text: 'x' } },
        { confirmTimeoutMs: 299 },
      )
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HmdWAError);
    expect((err as HmdWAError).code).toBe('CONFIG_ERROR');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects confirmTimeoutMs > 30000 with CONFIG_ERROR before any fetch call', async () => {
    const mockFetch = vi.fn() as unknown as typeof fetch;
    const client = hmdWA({ apiKey: API_KEY, baseUrl: BASE_URL, fetch: mockFetch });

    const err = await client
      .sendAndConfirm(
        { to: '+447700900123', channel: 'transactional', body: { kind: 'text', text: 'x' } },
        { confirmTimeoutMs: 30001 },
      )
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HmdWAError);
    expect((err as HmdWAError).code).toBe('CONFIG_ERROR');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects non-integer confirmTimeoutMs (1500.5) with CONFIG_ERROR before any fetch call', async () => {
    const mockFetch = vi.fn() as unknown as typeof fetch;
    const client = hmdWA({ apiKey: API_KEY, baseUrl: BASE_URL, fetch: mockFetch });

    const err = await client
      .sendAndConfirm(
        { to: '+447700900123', channel: 'transactional', body: { kind: 'text', text: 'x' } },
        { confirmTimeoutMs: 1500.5 },
      )
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HmdWAError);
    expect((err as HmdWAError).code).toBe('CONFIG_ERROR');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Idempotency key forwarding
// ---------------------------------------------------------------------------

describe('sendAndConfirm, idempotency key validation', () => {
  it("rejects short idempotencyKey ('short', 5 chars) with CONFIG_ERROR before any fetch call", async () => {
    const mockFetch = vi.fn() as unknown as typeof fetch;
    const client = hmdWA({ apiKey: API_KEY, baseUrl: BASE_URL, fetch: mockFetch });

    const err = await client
      .sendAndConfirm(
        { to: '+447700900123', channel: 'transactional', body: { kind: 'text', text: 'x' } },
        { idempotencyKey: 'short' },
      )
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HmdWAError);
    expect((err as HmdWAError).code).toBe('CONFIG_ERROR');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Per-attempt timeout extension
// ---------------------------------------------------------------------------

describe('sendAndConfirm, per-attempt timeout extended by confirmTimeoutMs + 2000', () => {
  it('does not abort when fetch resolves within confirmTimeoutMs + 2000 ms window', async () => {
    // Strategy (mirrors client.timeout.test.ts's real-timer approach):
    // - Client base timeoutMs: 50ms, far too short for a normal confirm call.
    // - confirmTimeoutMs: 300ms → effective per-attempt timeout = 2300ms.
    // - mock fetch resolves after ~200ms (well within 2300ms, but outside 50ms).
    // If the SDK correctly overrides per-attempt timeout to confirmTimeoutMs+2000,
    // the call succeeds; if it uses the base 50ms timeout, it aborts.
    const responseBody: SendMessageResponse = { messageId: 'msg-ext-timeout', status: 'sent' };

    const mockFetch = (_url: string, init: RequestInit): Promise<Response> =>
      new Promise<Response>((resolve, reject) => {
        const signal = init.signal as AbortSignal | undefined;
        const timer = setTimeout(() => resolve(makeResponse(200, responseBody)), 200);
        if (signal) {
          const abort = (): void => {
            clearTimeout(timer);
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          };
          if (signal.aborted) {
            abort();
          } else {
            signal.addEventListener('abort', abort, { once: true });
          }
        }
      });

    const client = hmdWA({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      fetch: mockFetch as typeof fetch,
      timeoutMs: 50, // intentionally tiny base timeout
      maxRetries: 0,
    });

    const result = await client.sendAndConfirm(
      { to: '+447700900123', channel: 'transactional', body: { kind: 'text', text: 'ext' } },
      { confirmTimeoutMs: 300 }, // effective = 2300ms, fetch at 200ms is safe
    );

    expect(result.messageId).toBe('msg-ext-timeout');
    expect(result.status).toBe('sent');
  }, 5_000); // generous ceiling for real timers
});

// ---------------------------------------------------------------------------
// All four status values round-trip
// ---------------------------------------------------------------------------

describe('sendAndConfirm, surfaces all four status values', () => {
  const statuses: SendMessageResponse['status'][] = ['sent', 'failed', 'queued', 'scheduled'];

  for (const status of statuses) {
    it(`preserves status '${status}' verbatim from the gateway response`, async () => {
      const responseBody: SendMessageResponse = { messageId: `msg-status-${status}`, status };
      const mockFetch = makeMockFetch(200, responseBody);
      const client = hmdWA({ apiKey: API_KEY, baseUrl: BASE_URL, fetch: mockFetch });

      const result = await client.sendAndConfirm({
        to: '+447700900123',
        channel: 'transactional',
        body: { kind: 'text', text: 'status check' },
      });

      expect(result.status).toBe(status);
    });
  }
});

/**
 * SDK client, send happy path with an injected mock fetch.
 */
import { describe, it, expect, vi } from 'vitest';
import { hmdWA } from '../src/index.js';
import type { SendMessageResponse } from '@hmddevs/protocol';

const API_KEY = 'test-api-key-send';
const BASE_URL = 'https://wa.test.example';

function makeMockFetch(status: number, body: unknown): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: () => Promise.resolve(JSON.stringify(body)),
  }) as unknown as typeof fetch;
}

describe('client.send, happy path', () => {
  it('resolves with SendMessageResponse on 202', async () => {
    const responseBody: SendMessageResponse = { messageId: 'msg-uuid-1', status: 'queued' };
    const mockFetch = makeMockFetch(202, responseBody);
    const client = hmdWA({ apiKey: API_KEY, baseUrl: BASE_URL, fetch: mockFetch });

    const req = {
      to: '+447700900123',
      channel: 'transactional' as const,
      body: { kind: 'text' as const, text: 'Hello' },
    };

    const result = await client.send(req);
    expect(result.messageId).toBe('msg-uuid-1');
    expect(result.status).toBe('queued');
  });

  it('calls POST /v1/messages with the correct URL and method', async () => {
    const responseBody: SendMessageResponse = { messageId: 'msg-uuid-2', status: 'queued' };
    const mockFetch = makeMockFetch(202, responseBody);
    const client = hmdWA({ apiKey: API_KEY, baseUrl: BASE_URL, fetch: mockFetch });

    await client.send({
      to: '+447700900123',
      channel: 'notification' as const,
      body: { kind: 'text' as const, text: 'Hi' },
    });

    const [url, init] = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe(`${BASE_URL}/v1/messages`);
    expect(init.method).toBe('POST');
  });

  it('sends Authorization: Bearer <key> header', async () => {
    const responseBody: SendMessageResponse = { messageId: 'msg-uuid-3', status: 'queued' };
    const mockFetch = makeMockFetch(202, responseBody);
    const client = hmdWA({ apiKey: API_KEY, baseUrl: BASE_URL, fetch: mockFetch });

    await client.send({
      to: '+447700900123',
      channel: 'notification' as const,
      body: { kind: 'text' as const, text: 'Auth check' },
    });

    const [, init] = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe(`Bearer ${API_KEY}`);
  });

  it('forwards idempotencyKey from opts into the request body', async () => {
    const responseBody: SendMessageResponse = { messageId: 'msg-uuid-4', status: 'queued' };
    const mockFetch = makeMockFetch(202, responseBody);
    const client = hmdWA({ apiKey: API_KEY, baseUrl: BASE_URL, fetch: mockFetch });

    await client.send(
      {
        to: '+447700900123',
        channel: 'transactional' as const,
        body: { kind: 'text' as const, text: 'idem' },
      },
      { idempotencyKey: 'key-opts-abc' },
    );

    const [, init] = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    // Header is no longer sent, gateway reads the key from the body only.
    expect(headers['Idempotency-Key']).toBeUndefined();
    const parsed = JSON.parse(init.body as string) as { idempotencyKey?: string };
    expect(parsed.idempotencyKey).toBe('key-opts-abc');
  });

  it('preserves idempotencyKey when supplied directly in the request body', async () => {
    const responseBody: SendMessageResponse = { messageId: 'msg-uuid-5', status: 'queued' };
    const mockFetch = makeMockFetch(202, responseBody);
    const client = hmdWA({ apiKey: API_KEY, baseUrl: BASE_URL, fetch: mockFetch });

    await client.send({
      to: '+447700900123',
      channel: 'transactional' as const,
      body: { kind: 'text' as const, text: 'idem body' },
      idempotencyKey: 'key-body-xyz',
    });

    const [, init] = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const parsed = JSON.parse(init.body as string) as { idempotencyKey?: string };
    expect(parsed.idempotencyKey).toBe('key-body-xyz');
  });
});

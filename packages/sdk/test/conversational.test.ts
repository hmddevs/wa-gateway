/**
 * SDK client, conversational primitives (slice 1).
 *
 * Covers:
 *   - client.react: POST /v1/messages/:id/reactions with emoji body
 *   - client.react with empty emoji throws CONFIG_ERROR before any fetch
 *   - client.unreact: DELETE /v1/messages/:id/reactions
 *   - client.setTyping: POST /v1/sessions/:id/presence with composing/paused
 *   - client.setTyping with empty `to` throws CONFIG_ERROR
 *   - client.setPresence: body with/without to field
 *   - client.send with replyTo forwards the field unchanged
 *   - resolveSessionId precedence: explicit > env var > 'default'
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { hmdWA, HmdWAError } from '../src/index.js';
import type { ReactionResponse, PresenceResponse, SendMessageResponse } from '@hmddevs/protocol';

const API_KEY = 'test-api-key-conversational';
const BASE_URL = 'https://wa.test.example';

function makeMockFetch(status: number, body: unknown): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: () => Promise.resolve(JSON.stringify(body)),
  }) as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------
// client.react, happy path
// ---------------------------------------------------------------------------

describe('client.react, happy path', () => {
  it('sends POST to /v1/messages/:id/reactions with the emoji in the body', async () => {
    const responseBody: ReactionResponse = {
      messageId: 'op-uuid-1',
      emoji: '👍',
      status: 'queued',
    };
    const mockFetch = makeMockFetch(202, responseBody);
    const client = hmdWA({ apiKey: API_KEY, baseUrl: BASE_URL, fetch: mockFetch });

    await client.react('msg-uuid-1', '👍');

    const [url, init] = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe(`${BASE_URL}/v1/messages/msg-uuid-1/reactions`);
    expect(init.method).toBe('POST');

    const parsed = JSON.parse(init.body as string) as { emoji: string };
    expect(parsed.emoji).toBe('👍');
  });

  it('sends Content-Type: application/json and Bearer authorisation header', async () => {
    const mockFetch = makeMockFetch(202, { messageId: 'op-uuid-2', emoji: '🎉', status: 'queued' });
    const client = hmdWA({ apiKey: API_KEY, baseUrl: BASE_URL, fetch: mockFetch });

    await client.react('msg-uuid-2', '🎉');

    const [, init] = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['Authorization']).toBe(`Bearer ${API_KEY}`);
  });
});

// ---------------------------------------------------------------------------
// client.react, empty emoji guard
// ---------------------------------------------------------------------------

describe('client.react, empty emoji guard', () => {
  it('throws HmdWAError (CONFIG_ERROR) before any fetch when emoji is empty', async () => {
    const mockFetch = vi.fn() as unknown as typeof fetch;
    const client = hmdWA({ apiKey: API_KEY, baseUrl: BASE_URL, fetch: mockFetch });

    await expect(client.react('msg-uuid-3', '')).rejects.toSatisfy(
      (err: unknown) => err instanceof HmdWAError && err.code === 'CONFIG_ERROR',
    );

    expect((mockFetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// client.unreact, happy path
// ---------------------------------------------------------------------------

describe('client.unreact, happy path', () => {
  it('sends DELETE to /v1/messages/:id/reactions', async () => {
    const mockFetch = makeMockFetch(202, { messageId: 'op-uuid-4', emoji: '', status: 'queued' });
    const client = hmdWA({ apiKey: API_KEY, baseUrl: BASE_URL, fetch: mockFetch });

    await client.unreact('msg-uuid-4');

    const [url, init] = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe(`${BASE_URL}/v1/messages/msg-uuid-4/reactions`);
    expect(init.method).toBe('DELETE');
  });

  it('sends no body on DELETE', async () => {
    const mockFetch = makeMockFetch(202, { messageId: 'op-uuid-5', emoji: '', status: 'queued' });
    const client = hmdWA({ apiKey: API_KEY, baseUrl: BASE_URL, fetch: mockFetch });

    await client.unreact('msg-uuid-5');

    const [, init] = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(init.body).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// client.setTyping
// ---------------------------------------------------------------------------

describe('client.setTyping, on: true', () => {
  it('posts to /v1/sessions/:id/presence with state composing and the to field', async () => {
    const responseBody: PresenceResponse = { status: 'queued' };
    const mockFetch = makeMockFetch(200, responseBody);
    const client = hmdWA({ apiKey: API_KEY, baseUrl: BASE_URL, fetch: mockFetch });

    await client.setTyping('+447700900123', true, { sessionId: 'foo' });

    const [url, init] = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe(`${BASE_URL}/v1/sessions/foo/presence`);
    expect(init.method).toBe('POST');

    const body = JSON.parse(init.body as string) as { state: string; to?: string };
    expect(body.state).toBe('composing');
    expect(body.to).toBe('+447700900123');
  });
});

describe('client.setTyping, on: false', () => {
  it('posts with state paused when on is false', async () => {
    const mockFetch = makeMockFetch(200, { status: 'queued' });
    const client = hmdWA({ apiKey: API_KEY, baseUrl: BASE_URL, fetch: mockFetch });

    await client.setTyping('+447700900123', false, { sessionId: 'foo' });

    const [, init] = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { state: string };
    expect(body.state).toBe('paused');
  });
});

describe('client.setTyping, empty to guard', () => {
  it('throws HmdWAError (CONFIG_ERROR) before any fetch when to is empty', async () => {
    const mockFetch = vi.fn() as unknown as typeof fetch;
    const client = hmdWA({ apiKey: API_KEY, baseUrl: BASE_URL, fetch: mockFetch });

    await expect(client.setTyping('', true, { sessionId: 'foo' })).rejects.toSatisfy(
      (err: unknown) => err instanceof HmdWAError && err.code === 'CONFIG_ERROR',
    );

    expect((mockFetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// client.setPresence
// ---------------------------------------------------------------------------

describe('client.setPresence, without to', () => {
  it('posts to /v1/sessions/:id/presence with state only (no to field)', async () => {
    const mockFetch = makeMockFetch(200, { status: 'queued' });
    const client = hmdWA({ apiKey: API_KEY, baseUrl: BASE_URL, fetch: mockFetch });

    await client.setPresence('available', { sessionId: 's' });

    const [url, init] = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe(`${BASE_URL}/v1/sessions/s/presence`);

    const body = JSON.parse(init.body as string) as { state: string; to?: string };
    expect(body.state).toBe('available');
    expect(body.to).toBeUndefined();
  });
});

describe('client.setPresence, with explicit to', () => {
  it('includes to in the body when opts.to is provided', async () => {
    const mockFetch = makeMockFetch(200, { status: 'queued' });
    const client = hmdWA({ apiKey: API_KEY, baseUrl: BASE_URL, fetch: mockFetch });

    await client.setPresence('unavailable', { sessionId: 's', to: '+447700900999' });

    const [, init] = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { state: string; to?: string };
    expect(body.state).toBe('unavailable');
    expect(body.to).toBe('+447700900999');
  });
});

// ---------------------------------------------------------------------------
// client.send, replyTo forwarding
// ---------------------------------------------------------------------------

describe('client.send, replyTo forwarding', () => {
  it('forwards replyTo.messageId unchanged in the request body', async () => {
    const responseBody: SendMessageResponse = { messageId: 'msg-reply-uuid', status: 'queued' };
    const mockFetch = makeMockFetch(202, responseBody);
    const client = hmdWA({ apiKey: API_KEY, baseUrl: BASE_URL, fetch: mockFetch });

    await client.send({
      to: '+447700900123',
      channel: 'transactional',
      body: { kind: 'text', text: 'Replying' },
      replyTo: { messageId: '00000000-0000-4000-8000-000000000099' },
    });

    const [, init] = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const parsed = JSON.parse(init.body as string) as {
      replyTo?: { messageId: string };
    };
    expect(parsed.replyTo?.messageId).toBe('00000000-0000-4000-8000-000000000099');
  });
});

// ---------------------------------------------------------------------------
// resolveSessionId precedence
// ---------------------------------------------------------------------------

describe('resolveSessionId, explicit sessionId overrides env var', () => {
  beforeEach(() => {
    process.env.HMD_WA_SESSION_ID = 'from-env';
  });

  afterEach(() => {
    delete process.env.HMD_WA_SESSION_ID;
  });

  it('uses the explicit sessionId from opts even when the env var is set', async () => {
    const mockFetch = makeMockFetch(200, { status: 'queued' });
    const client = hmdWA({ apiKey: API_KEY, baseUrl: BASE_URL, fetch: mockFetch });

    await client.setPresence('available', { sessionId: 'explicit-session' });

    const [url] = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toContain('/v1/sessions/explicit-session/presence');
  });
});

describe('resolveSessionId, env var used when no explicit sessionId', () => {
  beforeEach(() => {
    process.env.HMD_WA_SESSION_ID = 'env-session';
  });

  afterEach(() => {
    delete process.env.HMD_WA_SESSION_ID;
  });

  it('uses HMD_WA_SESSION_ID when opts does not specify sessionId', async () => {
    const mockFetch = makeMockFetch(200, { status: 'queued' });
    const client = hmdWA({ apiKey: API_KEY, baseUrl: BASE_URL, fetch: mockFetch });

    await client.setPresence('available', {});

    const [url] = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toContain('/v1/sessions/env-session/presence');
  });
});

describe('resolveSessionId, falls back to "default"', () => {
  beforeEach(() => {
    // Ensure the env var is absent for this suite.
    delete process.env.HMD_WA_SESSION_ID;
  });

  it('uses "default" when neither explicit sessionId nor env var is set', async () => {
    const mockFetch = makeMockFetch(200, { status: 'queued' });
    const client = hmdWA({ apiKey: API_KEY, baseUrl: BASE_URL, fetch: mockFetch });

    await client.setPresence('unavailable');

    const [url] = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toContain('/v1/sessions/default/presence');
  });
});

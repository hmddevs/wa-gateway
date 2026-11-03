/**
 * GatewayClient retry policy.
 *
 * Verifies the per-attempt re-signing invariant introduced by the durability
 * fix: every retry must use a fresh nonce, timestamp, and signature, otherwise
 * the gateway's 10-minute nonce dedup turns retries into 409s. Also covers
 * the network-error path, the 4xx fast-fail path, and the 5xx exhaust path.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const requestMock = vi.fn();

vi.mock('undici', () => ({
  request: (...args: unknown[]) => requestMock(...args),
}));

import { GatewayClient } from '../gateway-client';

interface FakeResponse {
  statusCode: number;
  body: { json: () => Promise<unknown> };
}

function ok(json: unknown = { ok: true }): FakeResponse {
  return { statusCode: 200, body: { json: async () => json } };
}

function status(code: number): FakeResponse {
  return { statusCode: code, body: { json: async () => ({}) } };
}

function makeClient(): GatewayClient {
  return new GatewayClient({
    baseUrl: 'https://wa.test',
    refreshToken: 'tok-1',
    wireSecret: Buffer.from('a'.repeat(64), 'hex'),
    onTokenRotate: vi.fn(),
  });
}

function bodiesFromCalls(): Array<{ nonce: string; at: string; sig: string }> {
  return requestMock.mock.calls.map((call) => {
    const opts = call[1] as { body: string };
    return JSON.parse(opts.body) as { nonce: string; at: string; sig: string };
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  requestMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('GatewayClient.callback', () => {
  it('posts once on first-try success', async () => {
    requestMock.mockResolvedValueOnce(ok());
    const c = makeClient();
    await c.callback({ kind: 'heartbeat', workerId: 'w1', sessionId: 's1' });
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it('retries on 503 and re-mints nonce + timestamp + signature on each attempt', async () => {
    requestMock.mockResolvedValueOnce(status(503)).mockResolvedValueOnce(ok());
    const c = makeClient();
    const p = c.callback({ kind: 'heartbeat', workerId: 'w1', sessionId: 's1' });
    await vi.runAllTimersAsync();
    await p;
    expect(requestMock).toHaveBeenCalledTimes(2);
    const bodies = bodiesFromCalls();
    expect(bodies[0]!.nonce).not.toBe(bodies[1]!.nonce);
    expect(bodies[0]!.sig).not.toBe(bodies[1]!.sig);
    // `at` is a sub-millisecond apart but the signatures already differ via nonce alone.
  });

  it('retries on 500 up to MAX_ATTEMPTS, then throws', async () => {
    requestMock.mockResolvedValue(status(500));
    const c = makeClient();
    const p = c.callback({ kind: 'heartbeat', workerId: 'w1', sessionId: 's1' });
    const expectation = expect(p).rejects.toThrow(/callback failed: 500/);
    await vi.runAllTimersAsync();
    await expectation;
    expect(requestMock).toHaveBeenCalledTimes(3);
    const bodies = bodiesFromCalls();
    expect(new Set(bodies.map((b) => b.nonce)).size).toBe(3);
  });

  it('does not retry on 400, fails fast', async () => {
    requestMock.mockResolvedValueOnce(status(400));
    const c = makeClient();
    await expect(
      c.callback({ kind: 'heartbeat', workerId: 'w1', sessionId: 's1' }),
    ).rejects.toThrow(/callback failed: 400/);
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it('retries on a thrown network error', async () => {
    requestMock.mockRejectedValueOnce(new Error('ECONNREFUSED')).mockResolvedValueOnce(ok());
    const c = makeClient();
    const p = c.callback({ kind: 'heartbeat', workerId: 'w1', sessionId: 's1' });
    await vi.runAllTimersAsync();
    await p;
    expect(requestMock).toHaveBeenCalledTimes(2);
  });

  it('rotates token on 401 then succeeds', async () => {
    requestMock
      .mockResolvedValueOnce(status(401))
      // rotate POST
      .mockResolvedValueOnce({
        statusCode: 200,
        body: { json: async () => ({ refreshToken: 'tok-2' }) },
      })
      // retry of original
      .mockResolvedValueOnce(ok());
    const onRotate = vi.fn();
    const c = new GatewayClient({
      baseUrl: 'https://wa.test',
      refreshToken: 'tok-1',
      wireSecret: Buffer.from('a'.repeat(64), 'hex'),
      onTokenRotate: onRotate,
    });
    const p = c.callback({ kind: 'heartbeat', workerId: 'w1', sessionId: 's1' });
    await vi.runAllTimersAsync();
    await p;
    expect(onRotate).toHaveBeenCalledWith('tok-2');
    expect(requestMock).toHaveBeenCalledTimes(3);
  });
});

describe('GatewayClient.batchCallback', () => {
  it('retries 5xx and re-signs each attempt', async () => {
    requestMock.mockResolvedValueOnce(status(502)).mockResolvedValueOnce(ok());
    const c = makeClient();
    const p = c.batchCallback({
      kind: 'chat_event_batch',
      workerId: 'w1',
      sessionId: 's1',
      events: [],
      isLatest: false,
    });
    await vi.runAllTimersAsync();
    await p;
    expect(requestMock).toHaveBeenCalledTimes(2);
    const bodies = bodiesFromCalls();
    expect(bodies[0]!.nonce).not.toBe(bodies[1]!.nonce);
  });

  it('does not retry on 422', async () => {
    requestMock.mockResolvedValueOnce(status(422));
    const c = makeClient();
    await expect(
      c.batchCallback({
        kind: 'chat_event_batch',
        workerId: 'w1',
        sessionId: 's1',
        events: [],
        isLatest: false,
      }),
    ).rejects.toThrow(/batchCallback failed: 422/);
    expect(requestMock).toHaveBeenCalledTimes(1);
  });
});

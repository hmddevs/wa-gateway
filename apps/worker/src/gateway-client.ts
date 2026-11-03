/**
 * Gateway client, HTTPS calls from the worker to the public gateway.
 *
 * Uses `undici` with Node 20 fetch-compatible Request init. All envelopes
 * are HMAC-signed before sending.
 *
 * Retry policy for `callback` and `batchCallback`:
 *   - Up to 3 attempts total (initial + 2 retries) on network errors and 5xx.
 *   - Exponential backoff with jitter: ~250ms, ~750ms.
 *   - Each attempt re-mints the nonce, timestamp, and signature so the
 *     gateway's nonce dedup (10-min TTL) doesn't 409 retries. Duplicate
 *     writes are absorbed by collection-level unique indexes
 *     (`waMessageId` on `inbound_messages`, `(sessionId, waMessageId)` on
 *     `chat_events`) which already treat 11000 as success.
 *   - 4xx (except 401, which special-cases token rotation) is fatal.
 */
import { request } from 'undici';
import { randomUUID, createHmac } from 'node:crypto';
import { canonicalJson } from '@hmddevs/protocol';

/**
 * Mutable single-slot holder for the worker's refresh token. Sharing one
 * instance across every GatewayClient in the process (control + per-session)
 * means a single rotation, proactive or reactive, is seen by all of them at
 * once. Without this, each client kept a private copy and a concurrent rotate
 * would leave the others replaying a now-stale generation.
 */
export interface TokenStore {
  token: string;
}

export interface GatewayClientOpts {
  baseUrl: string;
  refreshToken: string;
  /**
   * Shared token holder. When omitted a private one is seeded from
   * `refreshToken` (used by unit tests and any standalone client).
   */
  tokenStore?: TokenStore;
  wireSecret: Buffer;
  onTokenRotate: (newToken: string) => void;
}

const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 250;

function hmacHex(secret: Buffer, data: string): string {
  return createHmac('sha256', secret).update(data).digest('hex');
}

function jitteredBackoff(attempt: number): number {
  const base = BASE_BACKOFF_MS * Math.pow(3, attempt - 1);
  const jitter = base * 0.25 * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(base + jitter));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class GatewayClient {
  private readonly store: TokenStore;
  constructor(private readonly opts: GatewayClientOpts) {
    this.store = opts.tokenStore ?? { token: opts.refreshToken };
  }

  private signEnvelope<T extends { sig: string }>(env: T): T {
    const payload = canonicalJson({ ...env, sig: '' });
    return { ...env, sig: hmacHex(this.opts.wireSecret, payload) };
  }

  private buildEnvelope(payload: Record<string, unknown>): Record<string, unknown> {
    return this.signEnvelope({
      v: 1,
      ...payload,
      nonce: randomUUID(),
      at: new Date().toISOString(),
      sig: '',
    });
  }

  async rotateToken(): Promise<void> {
    const r = await request(`${this.opts.baseUrl}/v1/worker/refresh`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.store.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    if (r.statusCode !== 200) {
      throw new Error(`refresh failed: ${r.statusCode}`);
    }
    const body = (await r.body.json()) as { refreshToken: string };
    this.store.token = body.refreshToken;
    this.opts.onTokenRotate(body.refreshToken);
  }

  async callback(payload: Record<string, unknown>): Promise<void> {
    await this.postWithRetry(`${this.opts.baseUrl}/v1/worker/callback`, payload, 'callback');
  }

  /**
   * Bulk callback for history sync. Posts `chat_event_batch` or
   * `contact_batch` envelopes to `/v1/worker/callback/batch`. Same auth,
   * rotate-on-401, and exponential-backoff retry as the single-event
   * `callback`. The outer envelope is signed once per attempt, inner items
   * don't carry their own nonce/at/sig.
   */
  async batchCallback(payload: Record<string, unknown>): Promise<void> {
    await this.postWithRetry(
      `${this.opts.baseUrl}/v1/worker/callback/batch`,
      payload,
      'batchCallback',
    );
  }

  private async postWithRetry(
    url: string,
    payload: Record<string, unknown>,
    label: string,
  ): Promise<void> {
    let lastErr: Error | null = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      // why: re-mint nonce + timestamp + signature on every attempt so the
      // gateway's nonce dedup doesn't 409 retries. Collection-level unique
      // indexes absorb any duplicate writes (waMessageId on inbound_messages,
      // (sessionId, waMessageId) on chat_events).
      const envelope = this.buildEnvelope(payload);
      try {
        const r = await request(url, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.store.token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(envelope),
        });
        if (r.statusCode === 200) return;
        if (r.statusCode === 401) {
          // Auth: rotate then retry the same attempt slot once. If the rotate
          // doesn't fix it, fall through to a normal retry with a fresh
          // signed envelope on the next loop iteration.
          await this.rotateToken();
          const envelope2 = this.buildEnvelope(payload);
          const r2 = await request(url, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${this.store.token}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify(envelope2),
          });
          if (r2.statusCode === 200) return;
          if (r2.statusCode >= 500) {
            lastErr = new Error(`${label} failed after rotate: ${r2.statusCode}`);
          } else {
            throw new Error(`${label} failed after rotate: ${r2.statusCode}`);
          }
        } else if (r.statusCode >= 500) {
          lastErr = new Error(`${label} failed: ${r.statusCode}`);
        } else {
          // 4xx other than 401, client error, no retry.
          throw new Error(`${label} failed: ${r.statusCode}`);
        }
      } catch (err: unknown) {
        // Network-level failure (ECONNREFUSED, ETIMEDOUT, etc.) or a thrown
        // error from the 4xx branch above. Re-throw the latter immediately;
        // retry the former.
        const msg = (err as Error).message;
        if (
          msg.startsWith(`${label} failed: 4`) ||
          msg.startsWith(`${label} failed after rotate: 4`)
        ) {
          throw err;
        }
        lastErr = err as Error;
      }
      if (attempt < MAX_ATTEMPTS) {
        await sleep(jitteredBackoff(attempt));
      }
    }
    throw lastErr ?? new Error(`${label} failed: exhausted retries`);
  }

  async getSessions(): Promise<{ sessions: { sessionId: string; label: string }[] }> {
    const r = await request(`${this.opts.baseUrl}/v1/worker/sessions`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${this.store.token}`,
      },
    });
    if (r.statusCode === 401) {
      // Rotate and retry once.
      await this.rotateToken();
      const r2 = await request(`${this.opts.baseUrl}/v1/worker/sessions`, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${this.store.token}`,
        },
      });
      if (r2.statusCode !== 200) {
        throw new Error(`getSessions failed after rotate: ${r2.statusCode}`);
      }
      return r2.body.json() as Promise<{ sessions: { sessionId: string; label: string }[] }>;
    }
    if (r.statusCode !== 200) {
      throw new Error(`getSessions failed: ${r.statusCode}`);
    }
    return r.body.json() as Promise<{ sessions: { sessionId: string; label: string }[] }>;
  }

  /**
   * Fetch per-session conversational config (read-receipt toggle, etc.).
   * No caching at this layer, the runtime caches and refreshes.
   */
  async getSessionConfig(
    sessionId: string,
  ): Promise<{ sendReadReceipts: boolean; syncFullHistory: boolean }> {
    const url = `${this.opts.baseUrl}/v1/worker/sessions/${encodeURIComponent(sessionId)}/config`;
    const r = await request(url, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${this.store.token}`,
      },
    });
    if (r.statusCode === 401) {
      // Rotate and retry once.
      await this.rotateToken();
      const r2 = await request(url, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${this.store.token}`,
        },
      });
      if (r2.statusCode !== 200) {
        throw new Error(`getSessionConfig failed after rotate: ${r2.statusCode}`);
      }
      return r2.body.json() as Promise<{
        sendReadReceipts: boolean;
        syncFullHistory: boolean;
      }>;
    }
    if (r.statusCode !== 200) {
      throw new Error(`getSessionConfig failed: ${r.statusCode}`);
    }
    return r.body.json() as Promise<{
      sendReadReceipts: boolean;
      syncFullHistory: boolean;
    }>;
  }

  verifyInbound<T extends { sig: string }>(envelope: T): boolean {
    const payload = canonicalJson({ ...envelope, sig: '' });
    const expected = hmacHex(this.opts.wireSecret, payload);
    return timingSafeHex(expected, envelope.sig);
  }
}

function timingSafeHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

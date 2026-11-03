/**
 * SDK webhook verification, round-trip and failure modes.
 *
 * `signWebhookPayload` is the gateway-side signer (from @hmddevs/protocol).
 * `verifyWebhook` is the SDK wrapper that adds Zod schema validation on top.
 */
import { describe, it, expect } from 'vitest';
import { signWebhookPayload, WebhookVerificationError } from '@hmddevs/protocol';
import { verifyWebhook } from '../src/webhook.js';

// A minimal valid WebhookEvent that satisfies WebhookEventSchema.
const validEvent = {
  type: 'message.queued' as const,
  eventId: '00000000-0000-4000-8000-000000000001',
  at: new Date().toISOString(),
  sessionId: 'session-a',
  messageId: '00000000-0000-4000-8000-000000000002',
  to: '+447700900123',
  category: 'transactional' as const,
};

const SECRET = 'super-secret-webhook-key-for-test';

describe('verifyWebhook, round-trip', () => {
  it('returns the parsed event when body is valid and signature matches', async () => {
    const body = JSON.stringify(validEvent);
    const sig = await signWebhookPayload(body, SECRET);
    const result = await verifyWebhook(body, sig.header, SECRET);
    expect(result.type).toBe('message.queued');
    expect(result.eventId).toBe(validEvent.eventId);
  });
});

describe('verifyWebhook, tampered body', () => {
  it('throws signature_mismatch when body is altered after signing', async () => {
    const body = JSON.stringify(validEvent);
    const sig = await signWebhookPayload(body, SECRET);
    const tampered = body.replace('session-a', 'session-evil');
    await expect(verifyWebhook(tampered, sig.header, SECRET)).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof WebhookVerificationError && err.code === 'signature_mismatch',
    );
  });
});

describe('verifyWebhook, tampered signature hex', () => {
  it('throws signature_mismatch when v1 hex is altered', async () => {
    const body = JSON.stringify(validEvent);
    const sig = await signWebhookPayload(body, SECRET);
    // Flip one character in the v1 hex.
    const badV1 = sig.v1.replace(/.$/, sig.v1.endsWith('f') ? '0' : 'f');
    const badHeader = `t=${sig.t},v1=${badV1}`;
    await expect(verifyWebhook(body, badHeader, SECRET)).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof WebhookVerificationError && err.code === 'signature_mismatch',
    );
  });
});

describe('verifyWebhook, stale timestamp', () => {
  it('throws stale_timestamp when t is older than the tolerance window', async () => {
    const body = JSON.stringify(validEvent);
    const nowSec = Math.floor(Date.now() / 1000);
    // Sign with a timestamp 10 minutes in the past (tolerance is 300 s).
    const staleSec = nowSec - 601;
    const sig = await signWebhookPayload(body, SECRET, staleSec);
    await expect(verifyWebhook(body, sig.header, SECRET)).rejects.toSatisfy(
      (err: unknown) => err instanceof WebhookVerificationError && err.code === 'stale_timestamp',
    );
  });
});

describe('verifyWebhook, missing header', () => {
  it('throws missing_header when signature header is null', async () => {
    const body = JSON.stringify(validEvent);
    await expect(verifyWebhook(body, null, SECRET)).rejects.toSatisfy(
      (err: unknown) => err instanceof WebhookVerificationError && err.code === 'missing_header',
    );
  });

  it('throws missing_header when signature header is undefined', async () => {
    const body = JSON.stringify(validEvent);
    await expect(verifyWebhook(body, undefined, SECRET)).rejects.toSatisfy(
      (err: unknown) => err instanceof WebhookVerificationError && err.code === 'missing_header',
    );
  });
});

describe('verifyWebhook, malformed header', () => {
  it('throws malformed_header when t= field is absent (v1= only)', async () => {
    const body = JSON.stringify(validEvent);
    const sig = await signWebhookPayload(body, SECRET);
    // Strip the t= part so only v1= remains.
    const malformedHeader = `v1=${sig.v1}`;
    await expect(verifyWebhook(body, malformedHeader, SECRET)).rejects.toSatisfy(
      (err: unknown) => err instanceof WebhookVerificationError && err.code === 'malformed_header',
    );
  });
});

describe('verifyWebhook, schema validation', () => {
  it('throws when signature passes but body fails WebhookEventSchema', async () => {
    // Valid HMAC but payload is not a WebhookEvent (missing required fields).
    const badPayload = JSON.stringify({ type: 'message.queued', eventId: 'not-a-uuid' });
    const sig = await signWebhookPayload(badPayload, SECRET);
    await expect(verifyWebhook(badPayload, sig.header, SECRET)).rejects.toThrow();
  });
});

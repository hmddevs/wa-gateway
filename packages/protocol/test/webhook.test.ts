/**
 * Protocol-level HMAC signing + verification round-trip.
 *
 * These tests exercise `signWebhookPayload` / `verifyWebhookPayload` directly,
 * without the Zod schema layer that the SDK wrapper adds.
 */
import { describe, it, expect } from 'vitest';
import {
  signWebhookPayload,
  verifyWebhookPayload,
  WebhookVerificationError,
} from '../src/webhook.js';

const SECRET = 'protocol-hmac-test-secret-32bytes';
const RAW_BODY = JSON.stringify({ type: 'message.sent', messageId: 'abc-123' });

describe('signWebhookPayload + verifyWebhookPayload, round-trip', () => {
  it('produces a verifiable signature for a given body', async () => {
    const sig = await signWebhookPayload(RAW_BODY, SECRET);
    const { t } = await verifyWebhookPayload(RAW_BODY, sig.header, SECRET);
    expect(t).toBe(sig.t);
  });

  it('header format is t=<unix>,v1=<hex>', async () => {
    const sig = await signWebhookPayload(RAW_BODY, SECRET);
    expect(sig.header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
  });
});

describe('verifyWebhookPayload, tampered body', () => {
  it('throws signature_mismatch when body differs from what was signed', async () => {
    const sig = await signWebhookPayload(RAW_BODY, SECRET);
    await expect(verifyWebhookPayload(RAW_BODY + ' ', sig.header, SECRET)).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof WebhookVerificationError && err.code === 'signature_mismatch',
    );
  });
});

describe('verifyWebhookPayload, tampered signature', () => {
  it('throws signature_mismatch when v1 hex is corrupted', async () => {
    const sig = await signWebhookPayload(RAW_BODY, SECRET);
    const corruptHex = sig.v1.replace(/.$/, sig.v1.endsWith('0') ? '1' : '0');
    await expect(
      verifyWebhookPayload(RAW_BODY, `t=${sig.t},v1=${corruptHex}`, SECRET),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof WebhookVerificationError && err.code === 'signature_mismatch',
    );
  });
});

describe('verifyWebhookPayload, stale timestamp', () => {
  it('throws stale_timestamp when t is outside the tolerance window', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const staleSec = nowSec - 400; // tolerance is 300 s
    const sig = await signWebhookPayload(RAW_BODY, SECRET, staleSec);
    await expect(verifyWebhookPayload(RAW_BODY, sig.header, SECRET)).rejects.toSatisfy(
      (err: unknown) => err instanceof WebhookVerificationError && err.code === 'stale_timestamp',
    );
  });

  it('accepts a timestamp right at the boundary', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    // At exactly tolerance - 1 s, should be accepted.
    const validSec = nowSec - 299;
    const sig = await signWebhookPayload(RAW_BODY, SECRET, validSec);
    const result = await verifyWebhookPayload(RAW_BODY, sig.header, SECRET);
    expect(result.t).toBe(validSec);
  });
});

describe('verifyWebhookPayload, missing header', () => {
  it('throws missing_header when header is null', async () => {
    await expect(verifyWebhookPayload(RAW_BODY, null, SECRET)).rejects.toSatisfy(
      (err: unknown) => err instanceof WebhookVerificationError && err.code === 'missing_header',
    );
  });

  it('throws missing_header when header is an empty string', async () => {
    await expect(verifyWebhookPayload(RAW_BODY, '', SECRET)).rejects.toSatisfy(
      (err: unknown) => err instanceof WebhookVerificationError && err.code === 'missing_header',
    );
  });
});

describe('verifyWebhookPayload, malformed header', () => {
  it('throws malformed_header when t= field is missing', async () => {
    const sig = await signWebhookPayload(RAW_BODY, SECRET);
    await expect(verifyWebhookPayload(RAW_BODY, `v1=${sig.v1}`, SECRET)).rejects.toSatisfy(
      (err: unknown) => err instanceof WebhookVerificationError && err.code === 'malformed_header',
    );
  });

  it('throws malformed_header when v1= hex is not 64 lowercase hex characters', async () => {
    const sig = await signWebhookPayload(RAW_BODY, SECRET);
    await expect(
      verifyWebhookPayload(RAW_BODY, `t=${sig.t},v1=tooshort`, SECRET),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof WebhookVerificationError && err.code === 'malformed_header',
    );
  });
});

describe('verifyWebhookPayload, custom tolerance', () => {
  it('accepts a 10-minute-old timestamp when toleranceSec is 700', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const tenMinAgo = nowSec - 600;
    const sig = await signWebhookPayload(RAW_BODY, SECRET, tenMinAgo);
    const result = await verifyWebhookPayload(RAW_BODY, sig.header, SECRET, { toleranceSec: 700 });
    expect(result.t).toBe(tenMinAgo);
  });
});

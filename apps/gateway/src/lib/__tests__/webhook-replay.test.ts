/**
 * Replay-attack rejection.
 *
 * Verifies that a webhook signed with a stale `t=` timestamp cannot pass the
 * protocol-level verifier. This is the consumer-side check that the gateway
 * documents for SDK integrators, confirming that a captured POST re-sent 10+
 * minutes later will always be rejected.
 *
 * Uses `verifyWebhookPayload` directly (no Zod layer) because the gateway is
 * the signer; this test exercises the verification semantics consumers rely on.
 */
import { describe, it, expect } from 'vitest';
import {
  signWebhookPayload,
  verifyWebhookPayload,
  WebhookVerificationError,
  WEBHOOK_TOLERANCE_SECONDS,
} from '@hmddevs/protocol';

const SECRET = 'replay-test-secret-key';
const PAYLOAD = JSON.stringify({
  type: 'message.queued',
  messageId: 'msg-replay-1',
  to: '+447700900123',
});

describe('replay-attack rejection', () => {
  it('rejects a payload signed 10 minutes ago with the default 300 s tolerance', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const tenMinAgoSec = nowSec - 600; // well outside the 300 s window

    const sig = await signWebhookPayload(PAYLOAD, SECRET, tenMinAgoSec);

    await expect(verifyWebhookPayload(PAYLOAD, sig.header, SECRET)).rejects.toSatisfy(
      (err: unknown) => err instanceof WebhookVerificationError && err.code === 'stale_timestamp',
    );
  });

  it('rejects at exactly one second past the tolerance boundary', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const justOverBoundarySec = nowSec - (WEBHOOK_TOLERANCE_SECONDS + 1);

    const sig = await signWebhookPayload(PAYLOAD, SECRET, justOverBoundarySec);

    await expect(verifyWebhookPayload(PAYLOAD, sig.header, SECRET)).rejects.toSatisfy(
      (err: unknown) => err instanceof WebhookVerificationError && err.code === 'stale_timestamp',
    );
  });

  it('accepts a payload signed one second inside the tolerance boundary', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const justInsideBoundarySec = nowSec - (WEBHOOK_TOLERANCE_SECONDS - 1);

    const sig = await signWebhookPayload(PAYLOAD, SECRET, justInsideBoundarySec);

    const result = await verifyWebhookPayload(PAYLOAD, sig.header, SECRET);
    expect(result.t).toBe(justInsideBoundarySec);
  });

  it('rejects even with a valid signature when the body has been altered (no double spend)', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const sig = await signWebhookPayload(PAYLOAD, SECRET, nowSec);
    const alteredPayload = PAYLOAD.replace('msg-replay-1', 'msg-attacker-fake');

    await expect(verifyWebhookPayload(alteredPayload, sig.header, SECRET)).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof WebhookVerificationError && err.code === 'signature_mismatch',
    );
  });
});

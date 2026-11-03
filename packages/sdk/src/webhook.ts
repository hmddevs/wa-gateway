/**
 * Webhook verification helper. Thin wrapper around the protocol's
 * `verifyWebhookPayload` that ALSO parses the body and validates it against
 * `WebhookEventSchema`, returning the typed event.
 *
 * Throws `WebhookVerificationError` from `@hmddevs/protocol` on any failure
 * (missing/malformed header, stale timestamp, signature mismatch, malformed
 * payload). Never returns silently on failure.
 */
import {
  verifyWebhookPayload,
  WebhookEventSchema,
  WebhookVerificationError,
  type WebhookEvent,
} from '@hmddevs/protocol';

export async function verifyWebhook(
  rawBody: string,
  signatureHeader: string | null | undefined,
  secret: string,
  options: { toleranceSec?: number; nowUnixSec?: number } = {},
): Promise<WebhookEvent> {
  if (typeof rawBody !== 'string') {
    throw new WebhookVerificationError(
      'malformed_header',
      'rawBody must be the exact string the gateway sent (do not pre-parse JSON)',
    );
  }
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new WebhookVerificationError('malformed_header', 'Missing webhook secret');
  }

  // Step 1: signature + replay window. Throws WebhookVerificationError on failure.
  await verifyWebhookPayload(rawBody, signatureHeader, secret, options);

  // Step 2: parse the body. Only after signature is proven good, never trust
  // body contents until HMAC has been verified.
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new WebhookVerificationError('malformed_header', 'Webhook body is not valid JSON');
  }

  const result = WebhookEventSchema.safeParse(parsed);
  if (!result.success) {
    throw new WebhookVerificationError(
      'malformed_header',
      `Webhook payload does not match WebhookEventSchema: ${result.error.message}`,
    );
  }

  return result.data;
}

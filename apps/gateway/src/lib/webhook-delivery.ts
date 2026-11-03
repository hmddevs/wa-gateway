/**
 * One-shot webhook HTTP delivery.
 *
 * Signs the canonical-JSON payload at call time so retries pick up a fresh
 * `t=<unix>`, then POSTs through `safePost` with a hard timeout. 2xx is
 * success; everything else (timeouts, transport errors, SSRF rejections) is
 * a failure.
 *
 * SSRF guard: `safePost` resolves the destination host, rejects any
 * RFC1918/loopback/link-local/CGNAT/IPv4-mapped-IPv6/unique-local address,
 * and pins the connection to the resolved IP so DNS rebinding can't swap
 * destinations between resolution and connect.
 */
import 'server-only';
import {
  WEBHOOK_DELIVERY_HEADER,
  WEBHOOK_EVENT_HEADER,
  WEBHOOK_HTTP_TIMEOUT_MS,
  WEBHOOK_SIGNATURE_HEADER,
  signWebhookPayload,
  type WebhookEventType,
} from '@hmddevs/protocol';
import { safePost } from './safe-fetch';

export interface DeliveryAttemptResult {
  ok: boolean;
  httpStatus: number | null;
  durationMs: number;
  error: string | null;
}

export interface DeliveryAttemptInput {
  url: string;
  payload: string;
  secret: string;
  eventType: WebhookEventType;
  deliveryId: string;
  /** Override timeout for tests/admin test endpoint. Defaults to protocol constant. */
  timeoutMs?: number;
}

export async function attemptDelivery(input: DeliveryAttemptInput): Promise<DeliveryAttemptResult> {
  const sig = await signWebhookPayload(input.payload, input.secret);
  const timeoutMs = input.timeoutMs ?? WEBHOOK_HTTP_TIMEOUT_MS;
  const start = Date.now();
  try {
    const res = await safePost(
      input.url,
      input.payload,
      {
        'Content-Type': 'application/json',
        [WEBHOOK_SIGNATURE_HEADER]: sig.header,
        [WEBHOOK_EVENT_HEADER]: input.eventType,
        [WEBHOOK_DELIVERY_HEADER]: input.deliveryId,
        'User-Agent': 'hmd-wa-gateway-webhook/1',
      },
      { timeoutMs },
    );
    const ok = res.status >= 200 && res.status < 300;
    return {
      ok,
      httpStatus: res.status,
      durationMs: Date.now() - start,
      error: ok ? null : `non-2xx status ${res.status}`,
    };
  } catch (err: unknown) {
    const e = err as Error;
    return {
      ok: false,
      httpStatus: null,
      durationMs: Date.now() - start,
      error: classifyDeliveryError(e),
    };
  }
}

/**
 * Map our internal SSRF / transport error strings to short, opaque codes
 * suitable for surfacing to admins. The full underlying error stays in
 * structured logs and the audit row.
 */
function classifyDeliveryError(err: Error): string {
  const m = err.message;
  if (m === 'URL_NOT_HTTPS') return 'destination_not_https';
  if (m === 'URL_NO_HOST') return 'destination_invalid_host';
  if (m === 'URL_DNS_EMPTY') return 'destination_dns_failed';
  if (m === 'URL_PRIVATE_IP') return 'destination_private_ip_blocked';
  if (m === 'URL_REDIRECT_NOT_ALLOWED') return 'destination_redirect_blocked';
  if (m === 'URL_TIMEOUT') return 'transport_timeout';
  return 'transport_error';
}

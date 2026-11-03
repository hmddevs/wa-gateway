/**
 * `@hmddevs/wa-sdk`, official client SDK for HMD's WhatsApp gateway.
 *
 * Zero runtime dependencies. Types come from `@hmddevs/protocol` (bundled at
 * build time via tsup `noExternal`). Use `hmdWA(...)` for outbound calls and
 * `verifyWebhook(...)` for inbound webhook verification.
 *
 *   import { hmdWA, verifyWebhook } from '@hmddevs/wa-sdk';
 *
 *   const wa = hmdWA({ baseUrl: 'https://wa.example.com' });
 *   await wa.send({
 *     to: '+447700900123',
 *     purpose: 'transactional',
 *     body: { kind: 'text', text: 'Hello' },
 *   });
 *
 *   const event = await verifyWebhook(rawBody, sigHeader, secret);
 */
import { createClient, type HmdWAClient, type HmdWAClientOptions } from './client.js';

export {
  HmdWAError,
  HMD_WA_ERROR_CODES,
  CLIENT_ERROR_CODES,
  type HmdWAErrorCode,
} from './errors.js';
export { verifyWebhook } from './webhook.js';
export {
  createClient,
  type HmdWAClient,
  type HmdWAClientOptions,
  type HmdWASendOptions,
  type HmdWASendAndConfirmOptions,
  type HmdWAGetOptions,
  type HmdWAListOptions,
  type HmdWAStatusOptions,
  type HmdWAListGroupsOptions,
  type HmdWAReactOptions,
  type HmdWAPresenceOptions,
  type HmdWASessionScopedOptions,
  SDK_VERSION,
} from './client.js';

/** Factory, preferred entrypoint. Equivalent to `createClient(opts)`. */
export function hmdWA(options: HmdWAClientOptions): HmdWAClient {
  return createClient(options);
}

// ----- Re-exports of public types from @hmddevs/protocol --------------------
//
// Re-exporting keeps SDK consumers from needing a direct dependency on the
// protocol package. `noExternal: ['@hmddevs/protocol']` in tsup.config.ts
// inlines the values at build time so we ship a single artefact.

export type {
  SendMessageRequest,
  SendMessageResponse,
  SendBody,
  SendChannel,
  SendReplyTo,
  GetMessageResponse,
  ListMessagesResponse,
  ListGroupsResponse,
  GroupSummary,
  WorkerStatusResponse,
  ErrorResponse,
  ReactionRequest,
  ReactionResponse,
  PresenceRequest,
  PresenceResponse,
  PresenceState,
  OptOutEntry,
  ListOptOutsResponse,
  MessagePurpose,
} from '@hmddevs/protocol';

// Zod schema for `purpose`, exported as a value so consumers can reuse the
// enum at runtime (form validation, route guards) without depending on the
// protocol package directly.
export { MessagePurposeSchema } from '@hmddevs/protocol';

export type {
  WebhookEvent,
  WebhookEventType,
  MessageQueuedEvent,
  MessageSentEvent,
  MessageDeliveredEvent,
  MessageReadEvent,
  MessageFailedEvent,
  InboundReceivedEvent,
  InboundReactionEvent,
  ContactOptedOutEvent,
  WebhookTestEvent,
} from '@hmddevs/protocol';

export {
  WebhookVerificationError,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_EVENT_HEADER,
  WEBHOOK_DELIVERY_HEADER,
  WEBHOOK_TOLERANCE_SECONDS,
} from '@hmddevs/protocol';

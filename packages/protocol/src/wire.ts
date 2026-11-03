/**
 * Wire protocol between gateway and worker over Upstash Redis Pub/Sub + Lists.
 * Every message is HMAC-signed; receivers MUST verify before acting.
 * Nonces deduped for 10 min. Clock skew tolerance ±60s.
 */
import { z } from 'zod';
import {
  MessageContentSchema,
  MessageCategorySchema,
  MessagePurposeSchema,
  ProjectIdSchema,
  E164Schema,
  SessionIdSchema,
  ChatEventDirectionSchema,
  ChatEventSourceSchema,
  ChatEventContentSchema,
  MessageRevisionDocBaseSchema,
  ContactDocBaseSchema,
  GroupMetadataSchema,
  type MessageRevisionKind,
  type MessageRevisionBody,
  type MessageRevisionDeletedBy,
} from './db.js';

// ----- Envelope primitives -----

export const NonceSchema = z.string().uuid();
export const IsoDateStringSchema = z.string().datetime({ offset: true });
export const HmacSigSchema = z.string().regex(/^[0-9a-f]{64}$/, 'hex SHA-256 HMAC');

const envelope = {
  nonce: NonceSchema,
  at: IsoDateStringSchema,
  sig: HmacSigSchema,
} as const;

// ----- Gateway → Worker -----

/**
 * Quoted-message reference passed to the worker so Baileys can render the
 * outbound message as a reply to a prior message. The gateway resolves the
 * caller-supplied `replyTo.messageId` (its own UUID) into these fields by
 * looking up the message doc.
 */
export const QuotedRefSchema = z.object({
  waMessageId: z.string(),
  fromMe: z.boolean(),
  /** For groups; null/undefined for 1:1 chats. */
  participantJid: z.string().optional(),
});
export type QuotedRef = z.infer<typeof QuotedRefSchema>;

export const SendCommandSchema = z.object({
  type: z.literal('send'),
  ...envelope,
  messageId: z.string().uuid(),
  /**
   * Tenant slug, populated by the gateway from `apiKey.projectId`. Never
   * sourced from the public request body, the caller cannot self-declare
   * which project a message is billed/audited against.
   */
  projectId: ProjectIdSchema,
  to: E164Schema,
  waJid: z.string(),
  category: MessageCategorySchema,
  /** Caller-declared intent, mirrored from the public send request. */
  purpose: MessagePurposeSchema,
  content: MessageContentSchema,
  attempt: z.number().int().nonnegative().max(10),
  quoted: QuotedRefSchema.optional(),
});
export type SendCommand = z.infer<typeof SendCommandSchema>;

/**
 * React to a prior message. Empty `emoji` clears the reaction. The worker
 * resolves the emoji into the Baileys `react` message form. Targets are
 * specified by raw WhatsApp message id + `fromMe` so this works for both
 * outbound (we authored) and inbound (peer authored) messages.
 */
export const ReactCommandSchema = z.object({
  type: z.literal('react'),
  ...envelope,
  messageId: z.string().uuid(),
  to: E164Schema,
  waJid: z.string(),
  targetWaMessageId: z.string(),
  targetFromMe: z.boolean(),
  emoji: z.string().max(8),
});
export type ReactCommand = z.infer<typeof ReactCommandSchema>;

/**
 * Presence / typing indicator. When `waJid` is set the presence is sent to
 * that chat only (typing indicator); when omitted it's a global presence
 * change (`available` / `unavailable`).
 */
export const PresenceCommandSchema = z.object({
  type: z.literal('presence'),
  ...envelope,
  state: z.enum(['available', 'unavailable', 'composing', 'recording', 'paused']),
  waJid: z.string().optional(),
});
export type PresenceCommand = z.infer<typeof PresenceCommandSchema>;

export const ControlCommandSchema = z.object({
  type: z.literal('control'),
  ...envelope,
  action: z.enum([
    'reload_config',
    'restart',
    'reset_session',
    'logout',
    'ping',
    'start_session',
    'stop_session',
  ]),
  sessionId: z.string().optional(),
});
export type ControlCommand = z.infer<typeof ControlCommandSchema>;

export const GatewayToWorkerSchema = z.discriminatedUnion('type', [
  SendCommandSchema,
  ControlCommandSchema,
  ReactCommandSchema,
  PresenceCommandSchema,
]);
export type GatewayToWorker = z.infer<typeof GatewayToWorkerSchema>;

// ----- Worker → Gateway -----

export const SendAckSchema = z.object({
  type: z.literal('send_ack'),
  ...envelope,
  messageId: z.string().uuid(),
  outcome: z.enum(['sent', 'failed']),
  waMessageId: z.string().optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      retryable: z.boolean(),
    })
    .optional(),
});
export type SendAck = z.infer<typeof SendAckSchema>;

/**
 * Worker → gateway send-ack envelope published over Redis pub/sub on channel
 * `wa:ack:<messageId>` to power the synchronous-confirm path on
 * `POST /v1/messages` (`confirm: true`).
 *
 * Distinct from `SendAckSchema` above, that envelope rides the existing
 * worker→gateway callback / list flow and is HMAC-signed with the standard
 * envelope primitives. This one is fire-and-forget from the worker's
 * perspective: the gateway must subscribe to `wa:ack:<messageId>` BEFORE
 * publishing the outbound to `wa:pending:<sessionId>` so a fast worker ack
 * cannot race the listener attaching. There is no signature, no nonce, the
 * channel name is per-message and the gateway only listens on channels it
 * just published for itself.
 *
 * `status` is binary terminal. `'delivered'` and `'read'` are observed via
 * the existing `ReceiptEventSchema` callback flow, not on this channel.
 *
 *   - `waMessageId` is set only when `status === 'sent'`.
 *   - `errorCode` is set only when `status === 'failed'`.
 */
export const SendAckEnvelopeSchema = z.object({
  messageId: z.string().uuid(),
  status: z.enum(['sent', 'failed']),
  errorCode: z.string().optional(),
  waMessageId: z.string().optional(),
  ts: z.string().datetime({ offset: true }),
});
export type SendAckEnvelope = z.infer<typeof SendAckEnvelopeSchema>;

export const ReceiptEventSchema = z.object({
  type: z.literal('receipt'),
  ...envelope,
  messageId: z.string().uuid(),
  waMessageId: z.string(),
  kind: z.enum(['delivered', 'read']),
});
export type ReceiptEvent = z.infer<typeof ReceiptEventSchema>;

export const InboundEventSchema = z.object({
  type: z.literal('inbound'),
  ...envelope,
  waMessageId: z.string(),
  from: E164Schema,
  fromJid: z.string(),
  content: z.object({
    type: z.enum(['text', 'image', 'document']),
    text: z.string().optional(),
    mediaUrl: z.string().url().optional(),
    mediaMimeType: z.string().optional(),
    mediaFileName: z.string().optional(),
  }),
});
export type InboundEvent = z.infer<typeof InboundEventSchema>;

/**
 * Inbound reaction, emitted when the peer reacts to a message in this chat
 * (their own or one we sent). `targetWaMessageId` is the WhatsApp id of the
 * reacted-to message; `targetFromMe` tells the gateway whether to look it up
 * in our outbound message log. Empty `emoji` means the reaction was cleared.
 */
export const ReactionEventSchema = z.object({
  type: z.literal('reaction'),
  ...envelope,
  targetWaMessageId: z.string(),
  targetFromMe: z.boolean(),
  from: E164Schema,
  fromJid: z.string(),
  emoji: z.string(),
});
export type ReactionEvent = z.infer<typeof ReactionEventSchema>;

export const HeartbeatSchema = z.object({
  type: z.literal('heartbeat'),
  ...envelope,
  workerId: z.string(),
  sessionId: z.string(),
  waConnected: z.boolean(),
  /** Outbound Redis subscription is live (connected AND listening). Optional
   *  for rollout compatibility with an older worker that does not yet report
   *  it; absent is treated as unknown, not as "down". */
  subscribed: z.boolean().optional(),
  waNumber: z.string().nullable(),
  queueLocalDepth: z.number().int().nonnegative(),
  version: z.string(),
  buildHash: z.string(),
  /** Pre-pair history-sync progress; null/absent means no sync in progress. */
  historySyncProgress: z
    .object({
      received: z.number().int().nonnegative(),
      isLatest: z.boolean(),
    })
    .nullable()
    .optional(),
});
export type Heartbeat = z.infer<typeof HeartbeatSchema>;

export const PairingEventSchema = z.object({
  type: z.literal('pairing'),
  ...envelope,
  workerId: z.string(),
  sessionId: z.string(),
  state: z.enum(['needed', 'in_progress', 'complete']),
  qrDataUrl: z.string().optional(),
  pairingCode: z.string().optional(),
});
export type PairingEvent = z.infer<typeof PairingEventSchema>;

/**
 * Conversation event captured by the worker for cases the legacy inbound /
 * outbound paths do not already cover, outbound messages typed on the paired
 * phone or another linked device, and live group messages. Persisted to the
 * `chat_events` collection on the gateway. Fan-out to webhook subscribers is
 * intentionally suppressed for these events.
 *
 * `ts` is wire ISO; the gateway converts to `Date` before storing.
 */
export const ChatEventSchema = z.object({
  type: z.literal('chat_event'),
  ...envelope,
  workerId: z.string().min(1),
  sessionId: SessionIdSchema,
  waMessageId: z.string().min(1),
  direction: ChatEventDirectionSchema,
  source: ChatEventSourceSchema,
  counterpartyJid: z.string().min(1),
  counterpartyE164: E164Schema.nullable(),
  content: ChatEventContentSchema,
  ts: z.string().datetime({ offset: true }),
});
export type ChatEvent = z.infer<typeof ChatEventSchema>;

/**
 * Inner event shape for `chat_event_batch`. The batch envelope supplies the
 * wire envelope (nonce/at/sig) and the discriminator, so per-event repeats
 * are stripped. Imported by the batch ingress route as the single source of
 * truth for the items it accepts.
 *
 * why: the wrapper batch schemas (with `type` discriminator) were removed, * the actual wire uses `kind` (set in the worker's `gateway-client`), so a
 * `type`-keyed wrapper would always have failed to parse. The wrapper shape
 * lives in the route alongside the other `kind`-keyed callback envelopes;
 * this item schema is the contract that crosses the boundary.
 */
export const ChatEventBatchItemSchema = ChatEventSchema.omit({
  type: true,
  nonce: true,
  at: true,
  sig: true,
  workerId: true,
  sessionId: true,
});
export type ChatEventBatchItem = z.infer<typeof ChatEventBatchItemSchema>;

/**
 * Group metadata pushed by the worker on connect and on group-changing
 * events (subject/description edits, participant add/remove/promote,
 * settings toggles). Persisted to the `groups` collection, keyed on
 * `(sessionId, jid)`, replace-on-conflict, see `GroupDocSchema`.
 *
 * The worker may batch many groups in one push (e.g. the initial fetch after
 * connect), hence `GroupMetadataEventBatchItemSchema` below.
 */
export const GroupMetadataEventSchema = z.object({
  type: z.literal('group_metadata'),
  ...envelope,
  workerId: z.string().min(1),
  sessionId: SessionIdSchema,
  metadata: GroupMetadataSchema,
});
export type GroupMetadataEvent = z.infer<typeof GroupMetadataEventSchema>;

/**
 * Inner event shape for `group_metadata_batch`. Same wrapper-vs-items split
 * as `ChatEventBatchItemSchema`; see that schema's note.
 */
export const GroupMetadataEventBatchItemSchema = GroupMetadataEventSchema.omit({
  type: true,
  nonce: true,
  at: true,
  sig: true,
  workerId: true,
  sessionId: true,
});
export type GroupMetadataEventBatchItem = z.infer<typeof GroupMetadataEventBatchItemSchema>;

/**
 * Inner contact shape for `contact_batch`. Same wrapper-vs-items split as
 * `ChatEventBatchItemSchema`; see that schema's note.
 */
export const ContactBatchItemSchema = z.object({
  jid: z.string().min(1),
  e164: E164Schema.nullable(),
  pushName: z.string().nullable(),
  notify: z.string().nullable(),
  verifiedName: z.string().nullable(),
  profilePicUrl: z.string().nullable(),
});
export type ContactBatchItem = z.infer<typeof ContactBatchItemSchema>;

/**
 * Worker → gateway revision event. Carries the same fields as
 * `MessageRevisionDoc` minus `capturedAt` (the gateway stamps that on insert)
 * and with `messageId` (the gateway-side UUID) replaced by `waMessageId` (the
 * raw WhatsApp message id). The worker has no reliable mapping from
 * `waMessageId → messageId`, the messages collection is gateway-side and the
 * lookup would race the original `chat_event` insert. The gateway resolves the
 * UUID at insert time via `messages.findByWaMessageId`; rows that arrive
 * before the original message land with `messageId: null` and are reconciled
 * in the viewer aggregation via the `waMessageId` lookup index.
 *
 * The same edit/delete refinement applies, `kind: 'edit'` requires a body,
 * `kind: 'delete'` forbids one and requires `deletedBy`.
 *
 * The protocol-level discriminator is `type` (matches `ChatEventSchema`,
 * `InboundEventSchema`, etc.). The gateway's `/v1/worker/callback` route
 * uses a `kind: 'message_revision'` envelope wrapper for its local
 * discriminated union, that wrapper is route-local because the route
 * envelope's outer discriminator collides with this schema's inner `kind`
 * (edit/delete), so the route renames the inner field to `revisionKind`.
 */
export const MessageRevisionEventSchema = MessageRevisionDocBaseSchema.omit({
  capturedAt: true,
  messageId: true,
})
  .extend({
    type: z.literal('message_revision'),
    waMessageId: z.string().min(1),
  })
  .superRefine((data, ctx) => {
    const shaped: {
      kind: MessageRevisionKind;
      body?: MessageRevisionBody;
      deletedBy?: MessageRevisionDeletedBy;
    } = { kind: data.kind, body: data.body, deletedBy: data.deletedBy };
    if (shaped.kind === 'edit') {
      if (!shaped.body) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['body'],
          message: "body is required when kind is 'edit'",
        });
      }
    } else {
      if (shaped.body) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['body'],
          message: "body must be absent when kind is 'delete'",
        });
      }
      if (!shaped.deletedBy) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['deletedBy'],
          message: "deletedBy is required when kind is 'delete'",
        });
      }
    }
  });
export type MessageRevisionEvent = z.infer<typeof MessageRevisionEventSchema>;

/**
 * Worker → gateway contact event. Same fields as `ContactDoc` minus
 * `capturedAt`. The `type` discriminator follows the protocol convention;
 * the route's `kind: 'contact'` wrapper is added in slice 4.
 */
export const ContactEventSchema = ContactDocBaseSchema.omit({ capturedAt: true }).extend({
  type: z.literal('contact'),
});
export type ContactEvent = z.infer<typeof ContactEventSchema>;

/**
 * Header marker the worker sets on `POST /v1/worker/callback/batch` envelopes
 * during pre-pair history backfill. The gateway uses this to apply a relaxed
 * per-session rate-limit policy, history is bursty by definition. Slice 4
 * is the consumer; this slice only locks the wire shape.
 */
export const HistorySyncBatchHeaderSchema = z.object({
  historySync: z.literal(true),
  sessionId: SessionIdSchema,
  batchIndex: z.number().int().min(0),
  batchTotal: z.number().int().min(1).optional(),
});
export type HistorySyncBatchHeader = z.infer<typeof HistorySyncBatchHeaderSchema>;

export const WorkerToGatewaySchema = z.discriminatedUnion('type', [
  SendAckSchema,
  ReceiptEventSchema,
  InboundEventSchema,
  ReactionEventSchema,
  HeartbeatSchema,
  PairingEventSchema,
  ChatEventSchema,
]);
export type WorkerToGateway = z.infer<typeof WorkerToGatewaySchema>;

// ----- Channel helpers -----

export const channels = {
  outbound: (workerId: string) => `wa:outbound:${workerId}`,
  inbound: (workerId: string) => `wa:inbound:${workerId}`,
  control: (workerId: string) => `wa:control:${workerId}`,
  pending: (workerId: string) => `wa:pending:${workerId}`,
  processing: (workerId: string) => `wa:processing:${workerId}`,
  logs: (workerId: string) => `wa:logs:${workerId}`,
  nonceSeen: (nonce: string) => `wa:nonce:${nonce}`,
} as const;

export const NONCE_TTL_SECONDS = 600;
export const CLOCK_SKEW_TOLERANCE_SECONDS = 60;

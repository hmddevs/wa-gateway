/**
 * Public HTTP API schemas, single source of truth for what the SDK sends and
 * what the gateway accepts. Any change requires a row in docs/API.md in the
 * same PR. Keep this file aligned with the actual route handlers in
 * `apps/gateway/src/app/v1/`.
 *
 * Note: the internal worker wire format (see `wire.ts`) uses `category` /
 * `content` because that mirrors the underlying DB shape and the Baileys
 * call surface. The public HTTP API uses `channel` / `body` because that is
 * the language HMD service teams actually reach for. Translation happens
 * inside the gateway route handler.
 */
import { z } from 'zod';
import { E164Schema, MessagePurposeSchema, GroupParticipantSchema } from './db.js';

// ----- Body discriminated union -----

export const SendBodyTextSchema = z.object({
  kind: z.literal('text'),
  text: z.string().min(1).max(4096),
});

export const SendBodyImageSchema = z.object({
  kind: z.literal('image'),
  url: z.string().url(),
  caption: z.string().max(1024).optional(),
});

export const SendBodyDocumentSchema = z.object({
  kind: z.literal('document'),
  url: z.string().url(),
  filename: z.string().min(1).max(255).optional(),
  caption: z.string().max(1024).optional(),
});

export const SendBodySchema = z.discriminatedUnion('kind', [
  SendBodyTextSchema,
  SendBodyImageSchema,
  SendBodyDocumentSchema,
]);
export type SendBody = z.infer<typeof SendBodySchema>;

// ----- POST /v1/messages -----

export const SendChannelSchema = z.enum(['notification', 'transactional', 'internal']);
export type SendChannel = z.infer<typeof SendChannelSchema>;

/**
 * Reference to a prior message that this send is quoting. The gateway resolves
 * `messageId` (its own UUID) to the underlying WhatsApp message key before
 * dispatch. The message must belong to this caller's API key (outbound) or
 * to the same session (inbound). Group quoting requires the original
 * `participantJid` and is reserved for a later slice.
 */
export const SendReplyToSchema = z.object({
  messageId: z.string().uuid(),
});
export type SendReplyTo = z.infer<typeof SendReplyToSchema>;

/** Matches a WhatsApp group JID, e.g. `120363012345678901@g.us`. Shared with `AdminSendRequestSchema`. */
export const GroupJidRegex = /^\d[\d-]{8,27}@g\.us$/;

/** Loose phone-shape check, the gateway route re-validates via `normalisePhone`. */
const PlausiblePhoneRegex = /^\+?[\d\s\-().]{6,20}$/;

/**
 * Loose "looks like a group JID" check, deliberately looser than
 * `GroupJidRegex`. The public route treats anything ending `@g.us` as a group
 * send and does the exact-shape check itself, returning `400 INVALID_PHONE`
 * on mismatch. Keeping this schema permissive means a malformed group JID
 * reaches that route-level check rather than failing here with the less
 * specific `INVALID_BODY`.
 */
const GroupJidLikeRegex = /@g\.us$/;

export const SendMessageRequestSchema = z.object({
  /**
   * Recipient phone number, E.164 (`+447700900123`) or any input the gateway
   * can normalise, OR a WhatsApp group JID (`120363XXXXXXXXXXXX@g.us`) for a
   * standalone group send. The gateway re-validates either shape at the trust
   * boundary; this schema is deliberately permissive.
   */
  to: z
    .string()
    .min(6)
    .max(40)
    .refine(
      (v) => PlausiblePhoneRegex.test(v) || GroupJidLikeRegex.test(v),
      'phone number or group JID',
    ),
  /** Message classification. Drives scope check (`send:notification` etc.) and worker throttle category. */
  channel: SendChannelSchema.default('transactional'),
  /**
   * Caller-declared intent. Required, no default, every send must explicitly
   * declare its purpose so compliance routing, retention, and audit reporting
   * can categorise it without guesswork. Distinct from `channel` (which gates
   * scope and worker throttling); `purpose` describes *why* the message is
   * being sent, not *how* it is dispatched.
   */
  purpose: MessagePurposeSchema,
  body: SendBodySchema,
  /** Optional caller-supplied idempotency key. Same key + apiKey = same messageId. */
  idempotencyKey: z.string().min(8).max(128).optional(),
  /** Drop after this many seconds if still queued. 30s..24h, default 30 minutes. */
  ttlSeconds: z.number().int().min(30).max(86_400).optional(),
  /** Quote a prior message. The recipient's WhatsApp client renders the quote inline. */
  replyTo: SendReplyToSchema.optional(),
  /**
   * ISO 8601 UTC datetime. When set and in the future, the message is held in
   * `status: 'scheduled'` and dispatched by the gateway cron at or after this
   * time. Must be at least 30 s from now and at most 30 days out.
   */
  sendAt: z.string().datetime({ offset: true }).optional(),
  /**
   * Opt-in synchronous-confirm mode. When `true`, the gateway awaits the
   * worker's send ack (or `confirmTimeoutMs`) before responding so the caller
   * gets a terminal `'sent' | 'failed'` status in the response body and can
   * fall back to email inline. Default behaviour (omitted/`false`) is the
   * existing 202+queued async path.
   */
  confirm: z.boolean().optional(),
  /**
   * Confirm-mode wait window in milliseconds (300–30000). Default of 5000 ms
   * is enforced gateway-side, not in this schema, so older callers that only
   * supply `confirm: true` continue to parse cleanly.
   */
  confirmTimeoutMs: z.number().int().min(300).max(30_000).optional(),
});
export type SendMessageRequest = z.infer<typeof SendMessageRequestSchema>;

/**
 * Status values: `'queued' | 'scheduled' | 'sent' | 'failed'` are the only
 * values the gateway emits in confirm-aware (`confirm: true`) responses, * the route maps DB-side `delivered`/`read` to `sent` and `expired` to
 * `failed` at the boundary. The async-path idempotent replay returns the
 * raw `MessageDoc.status`, so the schema must accept the full DB union to
 * keep that back-compat surface valid. `errorCode` is set only when
 * `status === 'failed'` (or via mapping for `expired`). `requestId` is
 * always populated on confirm-aware bodies and on error responses; older
 * async success bodies omit it, hence optional.
 */
export const SendMessageResponseSchema = z.object({
  messageId: z.string().uuid(),
  status: z.enum(['queued', 'scheduled', 'sent', 'delivered', 'read', 'failed', 'expired']),
  /** Set to true when an idempotency key replayed a prior message. */
  idempotent: z.boolean().optional(),
  /** Machine-readable failure code; present only when `status === 'failed'`. */
  errorCode: z.string().optional(),
  /** Mirrors the `X-Request-Id` response header. Useful for support/triage. */
  requestId: z.string().optional(),
});
export type SendMessageResponse = z.infer<typeof SendMessageResponseSchema>;

// ----- GET /v1/messages -----

export const ListMessagesResponseSchema = z.object({
  messages: z.array(
    z.object({
      messageId: z.string().uuid(),
      to: z.string(),
      channel: SendChannelSchema,
      /** Mirrored from `MessageDoc.purpose`; reflects the caller's declared intent. */
      purpose: MessagePurposeSchema,
      status: z.enum(['queued', 'scheduled', 'sent', 'delivered', 'read', 'failed', 'expired']),
      createdAt: z.union([z.string().datetime({ offset: true }), z.date()]),
      body: z.object({ kind: z.enum(['text', 'image', 'document']) }),
    }),
  ),
});
export type ListMessagesResponse = z.infer<typeof ListMessagesResponseSchema>;

// ----- GET /v1/groups -----
//
// Lets an API-key holder discover the WhatsApp group JIDs their bound session
// belongs to, so they can pass one as `to` on `POST /v1/messages`. Requires
// the `read:groups` scope. Results are derived from persisted chat events,
// so a group only appears once the session has seen at least one message in
// it (live or history-synced).

// Metadata fields below are additive and all optional: a group with chat
// activity but no captured metadata (worker never fetched it, or the fetch
// predates this feature) still appears in the list, just without them.
//
// `participants` exposes every member's JID and admin role to any API key
// holding `read:groups`, including members who never messaged the bound
// session directly. This is a deliberate, confirmed trade-off, not an
// oversight; document it prominently wherever this scope is described
// publicly.
export const GroupSummarySchema = z.object({
  /** WhatsApp group JID, e.g. `120363012345678901@g.us`. */
  jid: z.string().regex(GroupJidRegex, 'WhatsApp group JID'),
  /** Group subject/name, when the gateway has captured one. Not always available. */
  subject: z.string().optional(),
  /** ISO 8601 of the most recent message the gateway observed in this group. */
  lastActivityAt: z.string().datetime({ offset: true }).optional(),
  /** JID of whoever last changed the subject, when captured. */
  subjectOwner: z.string().optional(),
  /** ISO 8601 of the last subject change, when captured. */
  subjectTime: z.string().datetime({ offset: true }).optional(),
  /** ISO 8601 of group creation, when captured. */
  creation: z.string().datetime({ offset: true }).optional(),
  /** Group owner JID, when captured. */
  owner: z.string().optional(),
  desc: z.string().optional(),
  descId: z.string().optional(),
  /** Only admins may post when true. */
  announce: z.boolean().optional(),
  /** Only admins may change group settings when true. */
  restrict: z.boolean().optional(),
  /** Participant count as reported by Baileys, independent of `participants.length`. */
  size: z.number().int().min(0).optional(),
  /** Disappearing-messages duration in seconds; absent/0 means off. */
  ephemeralDuration: z.number().int().min(0).optional(),
  inviteCode: z.string().optional(),
  /** See the scope note above, every member JID + admin role is exposed here. */
  participants: z.array(GroupParticipantSchema).optional(),
  /** ISO 8601 of when the gateway last captured this group's metadata. */
  metadataFetchedAt: z.string().datetime({ offset: true }).optional(),
});
export type GroupSummary = z.infer<typeof GroupSummarySchema>;

export const ListGroupsResponseSchema = z.object({
  groups: z.array(GroupSummarySchema),
});
export type ListGroupsResponse = z.infer<typeof ListGroupsResponseSchema>;

// ----- GET /api/admin/sessions/:id/optouts -----

export const OptOutEntrySchema = z.object({
  phone: z.string(),
  source: z.enum(['keyword', 'admin']),
  keyword: z.string().optional(),
  createdAt: z.union([z.string().datetime({ offset: true }), z.date()]),
});
export type OptOutEntry = z.infer<typeof OptOutEntrySchema>;

export const ListOptOutsResponseSchema = z.object({
  optOuts: z.array(OptOutEntrySchema),
});
export type ListOptOutsResponse = z.infer<typeof ListOptOutsResponseSchema>;

// ----- Admin GET /api/admin/sessions/:id/threads -----
//
// A "thread" is the tuple `(sessionId, counterparty E.164)`. The gateway
// derives threads by union-aggregating the `messages` (outbound) and
// `inbound_messages` (inbound) collections per session. Read-only.

export const AdminThreadDirectionSchema = z.enum(['in', 'out']);
export type AdminThreadDirection = z.infer<typeof AdminThreadDirectionSchema>;

export const AdminMessageStatusSchema = z.enum([
  'queued',
  'scheduled',
  'sent',
  'delivered',
  'read',
  'failed',
  'expired',
]);
export type AdminMessageStatus = z.infer<typeof AdminMessageStatusSchema>;

export const AdminThreadSummarySchema = z.object({
  /** E.164 for DMs; group JID (e.g. `120363…@g.us`) for group threads. */
  counterparty: z.string(),
  /**
   * Discriminator between one-to-one DMs (default) and WhatsApp group
   * conversations. Optional so existing wire payloads parse cleanly; callers
   * should treat absence as `'dm'`.
   */
  type: z.enum(['dm', 'group']).default('dm'),
  /** Set only for groups, the raw `…@g.us` JID. Undefined for DMs. */
  counterpartyJid: z.string().optional(),
  /** ISO 8601 of the most recent message either way. */
  lastMessageAt: z.string().datetime({ offset: true }),
  /** Truncated preview (≤120 chars) of the latest message. Empty string for non-text. */
  lastMessagePreview: z.string().max(120),
  lastMessageDirection: AdminThreadDirectionSchema,
  /** Present only when `lastMessageDirection === 'out'`. */
  lastMessageStatus: AdminMessageStatusSchema.optional(),
  /** Inbound messages received after the most recent outbound. Heuristic, no admin "mark read" yet. */
  unreadCount: z.number().int().nonnegative(),
});
export type AdminThreadSummary = z.infer<typeof AdminThreadSummarySchema>;

export const AdminThreadsListResponseSchema = z.object({
  items: z.array(AdminThreadSummarySchema),
  /** Opaque base64 cursor for the next page; null when exhausted. */
  nextCursor: z.string().nullable(),
});
export type AdminThreadsListResponse = z.infer<typeof AdminThreadsListResponseSchema>;

export const AdminThreadMessageBodySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string() }),
  z.object({
    kind: z.literal('image'),
    caption: z.string().optional(),
    mediaFileName: z.string().optional(),
  }),
  z.object({
    kind: z.literal('document'),
    caption: z.string().optional(),
    mediaFileName: z.string().optional(),
  }),
  z.object({ kind: z.literal('audio') }),
  z.object({ kind: z.literal('video') }),
  z.object({ kind: z.literal('sticker') }),
  z.object({ kind: z.literal('other') }),
]);
export type AdminThreadMessageBody = z.infer<typeof AdminThreadMessageBodySchema>;

/**
 * Per-message revision projected by the viewer's `$lookup` join.
 * Mirrors the DB-side `MessageRevisionDoc` shape minus storage-only fields
 * (`_id`, `sessionId`, `messageId`, `waMessageId`, `capturedAt`, `source`).
 */
export const AdminThreadMessageRevisionSchema = z.object({
  revisionSeq: z.number().int().min(1),
  kind: z.enum(['edit', 'delete']),
  body: AdminThreadMessageBodySchema.optional(),
  deletedBy: z.enum(['self', 'sender', 'admin']).optional(),
  ts: z.string().datetime({ offset: true }),
});
export type AdminThreadMessageRevision = z.infer<typeof AdminThreadMessageRevisionSchema>;

/**
 * Reference to a quoted original message, projected onto each reply row by the
 * viewer. `messageId` is the gateway UUID when known (outbound original);
 * `null` when the original was inbound and never assigned a gateway UUID, or
 * when the worker captured only the raw `waMessageId` for an inbound quoted
 * reply. `bodyPreview` is a truncated text/caption excerpt from the original;
 * absent when the original is missing from our store (the UI still renders
 * the quote chrome from the remaining fields).
 */
export const AdminThreadMessageReplyToSchema = z.object({
  messageId: z.string().uuid().nullable(),
  waMessageId: z.string().min(1),
  fromMe: z.boolean(),
  bodyPreview: z.string().max(280).optional(),
});
export type AdminThreadMessageReplyTo = z.infer<typeof AdminThreadMessageReplyToSchema>;

/**
 * Per-peer reaction projected onto each message row. Latest reaction per
 * `(message, peer)` only; cleared reactions (`emoji === ''`) are filtered out
 * at projection time so the UI never renders empty pills.
 */
export const AdminThreadMessageReactionSchema = z.object({
  fromJid: z.string(),
  fromE164: E164Schema.nullable(),
  emoji: z.string(),
  ts: z.string().datetime({ offset: true }),
});
export type AdminThreadMessageReaction = z.infer<typeof AdminThreadMessageReactionSchema>;

export const AdminThreadMessageSchema = z.object({
  /** `messageId` for outbound, `inboundId` for inbound. Stable per direction. */
  messageId: z.string(),
  direction: AdminThreadDirectionSchema,
  ts: z.string().datetime({ offset: true }),
  body: AdminThreadMessageBodySchema,
  /** Set only on outbound items. */
  status: AdminMessageStatusSchema.optional(),
  /** Append-only edit/delete history, ordered by `revisionSeq` ascending. */
  revisions: z.array(AdminThreadMessageRevisionSchema).optional(),
  /** Body text after the latest edit. Absent when the latest revision is a delete. */
  latestBody: AdminThreadMessageBodySchema.optional(),
  /** ISO 8601 of the latest `'edit'` revision. */
  editedAt: z.string().datetime({ offset: true }).optional(),
  /** ISO 8601 of the latest `'delete'` revision. */
  deletedAt: z.string().datetime({ offset: true }).optional(),
  /** Quoted-original reference (UI renders the WhatsApp Web quote chrome). */
  replyTo: AdminThreadMessageReplyToSchema.optional(),
  /** Per-peer reactions, sorted by `ts` ascending; cleared rows filtered out. */
  reactions: z.array(AdminThreadMessageReactionSchema).optional(),
});
export type AdminThreadMessage = z.infer<typeof AdminThreadMessageSchema>;

export const AdminThreadMessagesResponseSchema = z.object({
  items: z.array(AdminThreadMessageSchema),
  nextCursor: z.string().nullable(),
});
export type AdminThreadMessagesResponse = z.infer<typeof AdminThreadMessagesResponseSchema>;

// ----- Admin POST /api/admin/sessions/:id/send -----
//
// Wire types for sending a WhatsApp message directly from the admin
// dashboard. Step-up authenticated; not coupled to any live API key, the
// gateway tags admin-originated docs with apiKeyId '__admin__'.

export const AdminSendBodySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string().min(1).max(4096) }),
  z.object({
    kind: z.literal('image'),
    url: z.string().url(),
    caption: z.string().max(1024).optional(),
  }),
  z.object({
    kind: z.literal('document'),
    url: z.string().url(),
    filename: z.string().min(1).max(255).optional(),
    caption: z.string().max(1024).optional(),
  }),
]);
export type AdminSendBody = z.infer<typeof AdminSendBodySchema>;

export const AdminSendRequestSchema = z.object({
  to: z.union([
    z.string().regex(/^\+[1-9]\d{7,14}$/, 'E.164 phone number'),
    z.string().regex(GroupJidRegex, 'WhatsApp group JID'),
  ]),
  body: AdminSendBodySchema,
  replyTo: z.object({ messageId: z.string().uuid() }).optional(),
});
export type AdminSendRequest = z.infer<typeof AdminSendRequestSchema>;

export const AdminSendResponseSchema = z.object({
  messageId: z.string().uuid(),
  status: z.literal('queued'),
});
export type AdminSendResponse = z.infer<typeof AdminSendResponseSchema>;

// ----- admin metrics -----

export const AdminMetricsSparkPointSchema = z.object({
  hour: z.number().int(), // 0-23, hours ago from now (0 = most recent full hour)
  count: z.number().int().nonnegative(),
});
export type AdminMetricsSparkPoint = z.infer<typeof AdminMetricsSparkPointSchema>;

export const AdminSessionMetricsSchema = z.object({
  sessionId: z.string(),
  window: z.object({
    from: z.string().datetime({ offset: true }),
    to: z.string().datetime({ offset: true }),
  }),
  messages: z.object({
    sent24h: z.number().int().nonnegative(),
    received24h: z.number().int().nonnegative(),
    failed24h: z.number().int().nonnegative(),
    sentSparkline: z.array(AdminMetricsSparkPointSchema), // 24 points, newest last
    receivedSparkline: z.array(AdminMetricsSparkPointSchema),
  }),
  webhooks: z.object({
    delivered24h: z.number().int().nonnegative(),
    failed24h: z.number().int().nonnegative(),
  }),
  workerStatus: z.string().nullable(), // SessionStatus or null if session unknown
  cachedAt: z.string().datetime({ offset: true }),
});
export type AdminSessionMetrics = z.infer<typeof AdminSessionMetricsSchema>;

// ----- Admin SSE GET /api/admin/sessions/:id/stream -----
//
// Server-Sent Events stream powering live updates in the admin Conversations
// panel. Each line is a `data:` frame holding an `AdminStreamEnvelope` JSON
// payload; clients parse `event.kind` to discriminate. The envelope `at`
// timestamp lets clients detect clock skew against their own wall clock.
//
// Channel naming: events for one session land on Redis pub/sub channel
// `admin:stream:<sessionId>`. The publish side lives in the worker callback
// route; the subscribe side is the SSE route handler.

export const AdminStreamInboundSchema = z.object({
  kind: z.literal('inbound'),
  sessionId: z.string(),
  counterpartyE164: E164Schema,
  ts: z.string().datetime({ offset: true }),
  preview: z.string().max(200),
  messageId: z.string(),
});
export type AdminStreamInbound = z.infer<typeof AdminStreamInboundSchema>;

export const AdminStreamChatEventSchema = z.object({
  kind: z.literal('chat_event'),
  sessionId: z.string(),
  /** Null when the counterparty is a group JID rather than an individual. */
  counterpartyE164: E164Schema.nullable(),
  /** History-sync directions are intentionally never published, bulk replay
   *  would spam the live UI. Only `out_device` and live `in` flow through. */
  direction: z.enum(['out_device', 'in']),
  ts: z.string().datetime({ offset: true }),
  preview: z.string().max(200),
  waMessageId: z.string(),
});
export type AdminStreamChatEvent = z.infer<typeof AdminStreamChatEventSchema>;

export const AdminStreamMessageStatusSchema = z.object({
  kind: z.literal('message_status'),
  sessionId: z.string(),
  messageId: z.string(),
  status: z.enum(['queued', 'sent', 'delivered', 'read', 'failed']),
});
export type AdminStreamMessageStatus = z.infer<typeof AdminStreamMessageStatusSchema>;

export const AdminStreamEventSchema = z.discriminatedUnion('kind', [
  AdminStreamInboundSchema,
  AdminStreamChatEventSchema,
  AdminStreamMessageStatusSchema,
]);
export type AdminStreamEvent = z.infer<typeof AdminStreamEventSchema>;

export const AdminStreamEnvelopeSchema = z.object({
  /** ISO 8601 wall-clock at the gateway when the event was published. */
  at: z.string().datetime({ offset: true }),
  event: AdminStreamEventSchema,
});
export type AdminStreamEnvelope = z.infer<typeof AdminStreamEnvelopeSchema>;

// ----- GET /v1/messages/:id -----

export const GetMessageResponseSchema = z.object({
  messageId: z.string().uuid(),
  to: z.string(),
  channel: SendChannelSchema,
  /** Mirrored from `MessageDoc.purpose`; reflects the caller's declared intent. */
  purpose: MessagePurposeSchema,
  status: z.enum(['queued', 'sent', 'delivered', 'read', 'failed', 'expired']),
  statusHistory: z.array(
    z.object({
      status: z.enum(['queued', 'sent', 'delivered', 'read', 'failed', 'expired']),
      at: z.union([z.string().datetime({ offset: true }), z.date()]),
      code: z.string().optional(),
      detail: z.string().optional(),
    }),
  ),
  createdAt: z.union([z.string().datetime({ offset: true }), z.date()]),
  ttlExpiresAt: z.union([z.string().datetime({ offset: true }), z.date()]),
  errorCode: z.string().optional(),
  body: z.object({ kind: z.enum(['text', 'image', 'document']) }),
});
export type GetMessageResponse = z.infer<typeof GetMessageResponseSchema>;

// ----- POST /v1/messages/:id/reactions -----
//
// Set or clear the reaction this session has on a message. Send the empty
// string (or `DELETE` the resource) to clear. WhatsApp's protocol allows one
// reaction per (sender, message), the previous one is replaced.

export const ReactionEmojiSchema = z
  .string()
  .min(0)
  .max(8)
  .refine((s) => s.length === 0 || /\p{Extended_Pictographic}/u.test(s), {
    message: 'Must be an emoji or empty string to clear',
  });

export const ReactionRequestSchema = z.object({
  emoji: ReactionEmojiSchema,
});
export type ReactionRequest = z.infer<typeof ReactionRequestSchema>;

export const ReactionResponseSchema = z.object({
  messageId: z.string().uuid(),
  emoji: z.string(),
  /** Reaction operations are fire-and-forget on Baileys; gateway acks queue. */
  status: z.literal('queued'),
});
export type ReactionResponse = z.infer<typeof ReactionResponseSchema>;

// ----- POST /v1/sessions/:sessionId/presence -----

export const PresenceStateSchema = z.enum([
  'available',
  'unavailable',
  'composing',
  'recording',
  'paused',
]);
export type PresenceState = z.infer<typeof PresenceStateSchema>;

export const PresenceRequestSchema = z.object({
  /** When set, presence is sent only to this recipient (chat presence). */
  to: z.string().min(6).max(20).optional(),
  state: PresenceStateSchema,
});
export type PresenceRequest = z.infer<typeof PresenceRequestSchema>;

export const PresenceResponseSchema = z.object({ status: z.literal('queued') });
export type PresenceResponse = z.infer<typeof PresenceResponseSchema>;

// ----- GET /v1/worker/status -----

export const WorkerStatusResponseSchema = z.object({
  workerId: z.string(),
  /** Set when the calling API key is bound to a session. */
  sessionId: z.string().optional(),
  status: z.enum(['initialising', 'pairing', 'connected', 'degraded', 'offline', 'stopped']),
  lastHeartbeatAt: z.union([z.string().datetime({ offset: true }), z.date(), z.null()]),
  connectedAt: z.union([z.string().datetime({ offset: true }), z.date(), z.null()]),
  phoneE164: z.string().nullable(),
  version: z.string().nullable(),
  queueDepth: z.number().int().nonnegative().nullable(),
});
export type WorkerStatusResponse = z.infer<typeof WorkerStatusResponseSchema>;

// ----- Error envelope -----
//
// The gateway emits a flat shape: `{ error, code, requestId }`. `error` is
// the human-readable message; `code` is the machine-readable identifier from
// `errors.ts`. Callers MUST match on `code`, `error` is for humans only.

export const ErrorResponseSchema = z.object({
  error: z.string(),
  code: z.string(),
  requestId: z.string(),
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

// ----- Limits -----

export const LIMITS = {
  MAX_BODY_BYTES: 64 * 1024,
  MAX_IMAGE_BYTES: 5 * 1024 * 1024,
  MAX_DOCUMENT_BYTES: 16 * 1024 * 1024,
  MAX_FETCH_MS: 10_000,
  MAX_TEXT_LEN: 4096,
} as const;

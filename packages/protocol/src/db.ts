/**
 * Database schemas (MongoDB). Timestamps stored as Date, UTC.
 * These Zod schemas describe the intended shape; the gateway writes them via
 * typed repositories. Not every field is runtime-validated on read (Mongo is
 * trusted), but every write path uses `.parse()` to enforce the invariant.
 */
import { z } from 'zod';

// ----- Common -----

export const E164Schema = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{6,14}$/, 'Must be E.164 (e.g. +447700900123)');

export const CidrSchema = z
  .string()
  .trim()
  .regex(/^(?:\d{1,3}\.){3}\d{1,3}(?:\/(?:\d|[12]\d|3[0-2]))?$|^[0-9a-fA-F:]+(?:\/\d{1,3})?$/);

/**
 * Lowercase kebab slug identifying the project (caller-tenant) an API key
 * belongs to. Stamped on every outbound message at gateway insert time and
 * propagated on the gateway → worker wire envelope. Single source of truth
 * for the regex; reused by `ApiKeyDoc`, `MessageDoc`, and `SendCommand`.
 *
 * Constraints: 1–64 chars; `[a-z0-9]` at both ends; `[a-z0-9-]` in the
 * middle. Cannot start or end with a hyphen.
 */
export const ProjectIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/, 'lowercase kebab slug');
export type ProjectId = z.infer<typeof ProjectIdSchema>;

/**
 * Caller-declared intent of an outbound message. Required on the public
 * send API. A free audit label only, persisted on every `MessageDoc` for
 * downstream reporting and categorisation; it never gates a send.
 */
export const MessagePurposeSchema = z.enum([
  'otp',
  'magic_link',
  'transactional',
  'notification',
  'support',
  'marketing',
  'campaign',
  'newsletter',
  'announcement',
  'other',
]);
export type MessagePurpose = z.infer<typeof MessagePurposeSchema>;

// ----- api_keys -----

export const ApiKeyScopeSchema = z.enum([
  'send:notification',
  'send:transactional',
  'send:internal',
  'send:new_recipients',
  'read:status',
  /** Discover the WhatsApp group JIDs the bound session belongs to, GET /v1/groups. */
  'read:groups',
]);
export type ApiKeyScope = z.infer<typeof ApiKeyScopeSchema>;

export const ApiKeyEnvironmentSchema = z.enum(['live', 'test']);
export type ApiKeyEnvironment = z.infer<typeof ApiKeyEnvironmentSchema>;

export const ApiKeyRateLimitSchema = z.object({
  perMinute: z.number().int().positive().max(100_000),
  perHour: z.number().int().positive().max(1_000_000),
  perDay: z.number().int().positive().max(10_000_000),
});

export const ApiKeySchema = z.object({
  keyId: z.string().min(1).max(128),
  keyHash: z.string().min(1), // argon2id
  keyLookupHash: z.string().length(64), // hex sha256 HMAC
  division: z.string().min(1).max(64),
  /** Tenant slug. Stamped onto every outbound message and propagated on the
   *  gateway → worker wire envelope. Required; never absent on a live key. */
  projectId: ProjectIdSchema,
  label: z.string().min(1).max(128),
  scopes: z.array(ApiKeyScopeSchema).min(1),
  rateLimit: ApiKeyRateLimitSchema,
  ipAllowlist: z.array(CidrSchema).nullable(),
  environment: ApiKeyEnvironmentSchema,
  createdAt: z.date(),
  createdBy: z.string().min(1),
  lastUsedAt: z.date().nullable(),
  lastUsedIp: z.string().nullable(),
  lastUsedUserAgent: z.string().nullable(),
  revokedAt: z.date().nullable(),
  revokedBy: z.string().nullable(),
  revokedReason: z.string().nullable(),
});
export type ApiKey = z.infer<typeof ApiKeySchema>;

// ----- messages -----

export const MessageCategorySchema = z.enum(['notification', 'transactional', 'internal']);
export type MessageCategory = z.infer<typeof MessageCategorySchema>;

export const MessageStatusSchema = z.enum([
  'queued',
  'scheduled',
  'dispatched',
  'sent',
  'delivered',
  'read',
  'failed',
  'expired',
]);
export type MessageStatus = z.infer<typeof MessageStatusSchema>;

export const MessageContentTextSchema = z.object({
  type: z.literal('text'),
  text: z.string().min(1).max(4096),
});

export const MessageContentImageSchema = z.object({
  type: z.literal('image'),
  mediaUrl: z.string().url(),
  mediaMimeType: z.string().max(128).optional(),
  caption: z.string().max(1024).optional(),
});

export const MessageContentDocumentSchema = z.object({
  type: z.literal('document'),
  mediaUrl: z.string().url(),
  mediaFileName: z.string().min(1).max(255),
  mediaMimeType: z.string().max(128).optional(),
  caption: z.string().max(1024).optional(),
});

export const MessageContentSchema = z.discriminatedUnion('type', [
  MessageContentTextSchema,
  MessageContentImageSchema,
  MessageContentDocumentSchema,
]);
export type MessageContent = z.infer<typeof MessageContentSchema>;

export const MessageStoredContentSchema = z.object({
  type: z.enum(['text', 'image', 'document']),
  text: z.string().optional(),
  mediaUrl: z.string().url().optional(),
  mediaMimeType: z.string().optional(),
  mediaFileName: z.string().optional(),
  textPreview: z.string().max(80).optional(),
  textRedacted: z.boolean().optional(),
});

export const MessageStatusHistoryItemSchema = z.object({
  status: MessageStatusSchema,
  at: z.date(),
  detail: z.string().optional(),
  workerId: z.string().optional(),
});

export const MessageSchema = z.object({
  messageId: z.string().uuid(),
  apiKeyId: z.string(),
  division: z.string(),
  /** Tenant slug copied from the originating API key at insert time. */
  projectId: ProjectIdSchema,
  category: MessageCategorySchema,
  /** Caller-declared intent. Mirrored from the public send request; required. */
  purpose: MessagePurposeSchema,
  to: E164Schema,
  toHash: z.string().length(64),
  waJid: z.string(),
  content: MessageStoredContentSchema,
  status: MessageStatusSchema,
  statusHistory: z.array(MessageStatusHistoryItemSchema),
  waMessageId: z.string().nullable(),
  attempts: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
  ttlExpiresAt: z.date(),
  webhookUrl: z.string().url().nullable(),
  webhookDeliveredAt: z.date().nullable(),
  webhookAttempts: z.number().int().nonnegative(),
  idempotencyKey: z.string().nullable(),
  requestIp: z.string(),
  requestUserAgent: z.string(),
  createdAt: z.date(),
  scheduledFor: z.date().nullable(),
  dispatchedAt: z.date().nullable(),
  sentAt: z.date().nullable(),
  deliveredAt: z.date().nullable(),
  readAt: z.date().nullable(),
});
export type Message = z.infer<typeof MessageSchema>;

// ----- opt_outs -----

export const OptOutSourceSchema = z.enum(['keyword', 'admin']);
export type OptOutSource = z.infer<typeof OptOutSourceSchema>;

export const OptOutSchema = z.object({
  sessionId: z.string().min(1),
  phone: E164Schema,
  source: OptOutSourceSchema,
  /** The matched keyword that triggered the opt-out, when source is 'keyword'. */
  keyword: z.string().max(32).optional(),
  createdAt: z.date(),
});
export type OptOut = z.infer<typeof OptOutSchema>;

// ----- audit_log -----

export const AuditActorSchema = z.object({
  type: z.enum(['admin', 'api', 'worker', 'system']),
  id: z.string(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
});

export const AuditEntrySchema = z.object({
  seq: z.number().int().nonnegative(),
  actor: AuditActorSchema,
  action: z.string().min(1).max(128),
  target: z.object({ type: z.string(), id: z.string().nullable() }),
  details: z.record(z.string(), z.unknown()),
  at: z.date(),
  prevHash: z.string().length(64), // hex SHA-256
  hash: z.string().length(64),
});
export type AuditEntry = z.infer<typeof AuditEntrySchema>;

// ----- sessions -----

export const SessionStatusSchema = z.enum([
  'initialising',
  'pairing',
  'connected',
  'degraded',
  'offline',
  'stopped',
]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const SessionIdSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9-]{2,32}$/, 'Must be 2-32 lowercase alphanumeric/hyphen chars');

export const SessionPairingSchema = z.object({
  event: z.enum(['qr', 'paired', 'logged_out']),
  qr: z.string().optional(),
  at: z.date(),
});

/**
 * Per-session conversational behaviour. New sessions default to
 * `sendReadReceipts: true` to preserve historical behaviour; existing sessions
 * without this field are treated as the default by readers.
 */
export const SessionConversationConfigSchema = z.object({
  sendReadReceipts: z.boolean().default(true),
  /**
   * Inbound message texts that trigger an automatic opt-out. Case-insensitive,
   * trimmed exact match. Defaults to ['STOP'] per industry convention.
   */
  optOutKeywords: z.array(z.string().max(32)).max(10).default(['STOP']),
  /**
   * Whether the worker requests Baileys' full chat-archive history sync on
   * pair. Defaults to `false` because (1) the canonical use case is outbound-
   * notification sessions where chat archive is wasted state, and (2) the
   * large incremental write during history sync is the load-bearing cause of
   * reboot-forces-rescan incidents (see PR #71 and #74). Set true for
   * sessions that genuinely need historical chat ingestion (inbound triage,
   * analytics), accept the reboot fragility as a trade-off.
   */
  syncFullHistory: z.boolean().default(false),
});
export type SessionConversationConfig = z.infer<typeof SessionConversationConfigSchema>;

export const OrgIdSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9-]{2,32}$/, 'Must be 2-32 lowercase alphanumeric/hyphen chars');

/**
 * Per-number send caps. WhatsApp throttles a phone number, not an API key, so
 * this is the axis that actually runs out, `ApiKeyRateLimitSchema` caps the
 * customer and is a different concern. All three windows are enforced together;
 * a send needs room in every one.
 */
export const SessionBudgetSchema = z.object({
  perMinute: z.number().int().positive().max(10_000),
  perHour: z.number().int().positive().max(100_000),
  perDay: z.number().int().positive().max(1_000_000),
});
export type SessionBudget = z.infer<typeof SessionBudgetSchema>;

export const SessionSchema = z.object({
  sessionId: SessionIdSchema,
  workerId: z.string().min(1),
  label: z.string().min(1).max(128),
  status: SessionStatusSchema,
  phoneE164: E164Schema.nullable(),
  pairing: SessionPairingSchema.nullable(),
  version: z.string().nullable(),
  lastHeartbeatAt: z.date().nullable(),
  connectedAt: z.date().nullable(),
  createdBy: z.string().min(1),
  createdAt: z.date(),
  stoppedAt: z.date().nullable(),
  conversation: SessionConversationConfigSchema.optional(),
  /** Organization this number routes for. Absent on sessions bound directly to
   *  a key, which keep the historical single-session path. */
  orgId: OrgIdSchema.optional(),
  /** Per-number send caps. Absent ⇒ the router's conservative defaults. */
  budget: SessionBudgetSchema.optional(),
  /** First-pair timestamp, used to ramp a fresh number's budget. Absent ⇒
   *  treated as fully warmed, so numbers already in production are not
   *  retroactively throttled. */
  warmupStartedAt: z.date().optional(),
  /** Admin kill-switch. A paused session is skipped by the router but keeps
   *  its connection and continues to receive inbound. */
  paused: z.boolean().optional(),
});
export type Session = z.infer<typeof SessionSchema>;

// ----- organizations -----

/**
 * How the router chooses between an organization's eligible numbers.
 *
 * `weighted` spreads load proportionally to remaining hourly budget, so a
 * number sheds traffic as it fills instead of running to its cap and stalling.
 * `priority` is the legacy pool behaviour, first eligible in list order, * kept for when one number is genuinely preferred and the rest are overflow.
 * `round-robin` rotates evenly for interchangeable numbers.
 */
export const OrgStrategySchema = z.enum(['weighted', 'priority', 'round-robin']);
export type OrgStrategy = z.infer<typeof OrgStrategySchema>;

/**
 * The unit an API key binds to. Holds the member sessions the router may pick
 * from; the consumer never names a session and never learns which one sent.
 * Replaces the `session_pools` collection, see docs/ORGANIZATIONS.md.
 */
export const OrganizationSchema = z.object({
  orgId: OrgIdSchema,
  label: z.string().min(1).max(128),
  /** Member session ids. Order is significant only under `priority`. */
  sessions: z.array(SessionIdSchema).max(64),
  strategy: OrgStrategySchema,
  createdAt: z.date(),
});
export type Organization = z.infer<typeof OrganizationSchema>;

// ----- pairingInvites -----

/**
 * Shareable, unauthenticated pairing link. Lets an admin hand a client a URL
 * that shows only the QR for a freshly-provisioned session, with no admin
 * access. Same two-hash pattern as `ApiKeySchema` (lookup hash for O(1) find,
 * verify hash for offline-attack resistance), the raw token is never
 * persisted. Distinct prefix (`hmd_pi_`) from API keys (`hmd_sk_`) keeps the
 * two token types from ever being confused or cross-verified.
 */
export const PairingInviteStatusSchema = z.enum(['active', 'expired', 'revoked']);
export type PairingInviteStatus = z.infer<typeof PairingInviteStatusSchema>;

/**
 * A shareable link that lets an organization pair its own WhatsApp numbers,
 * with no admin access and nothing to install.
 *
 * Scoped to an ORGANIZATION and reusable up to `maxSessions`, rather than the
 * previous one-link-one-session model: an operator hands a client a single URL
 * and the client adds however many numbers they need, each provisioned and
 * attached to the organization on the spot. That is the whole point, numbers
 * are what run out under a WhatsApp rate limit, and the person who can scan a
 * QR is rarely the person with admin access.
 *
 * `status` therefore has no 'connected' state: a link that has paired one
 * number is still live for the next. Usage is `sessionIds.length` against
 * `maxSessions`.
 */
export const PairingInviteSchema = z.object({
  inviteId: z.string().min(1).max(128),
  /** Numbers paired through this link are attached to this organization. */
  orgId: OrgIdSchema,
  workerId: z.string().min(1),
  lookupHash: z.string().length(64), // hex sha256 HMAC
  tokenHash: z.string().min(1), // argon2id
  label: z.string().max(128).optional(),
  createdBy: z.string().min(1), // admin email
  createdAt: z.date(),
  expiresAt: z.date(),
  status: PairingInviteStatusSchema,
  /** Hard cap on how many numbers this link may add. */
  maxSessions: z.number().int().min(1).max(20),
  /** Sessions provisioned through this link, oldest first. */
  sessionIds: z.array(SessionIdSchema),
});
export type PairingInviteDoc = z.infer<typeof PairingInviteSchema>;

// ----- worker_state -----

export const WorkerStateSchema = z.object({
  _id: z.literal('singleton'),
  workerId: z.string(),
  waNumber: z.string().nullable(),
  waConnected: z.boolean(),
  redisConnected: z.boolean(),
  lastHeartbeatAt: z.date(),
  lastReconnectAt: z.date().nullable(),
  version: z.string(),
  buildHash: z.string(),
  os: z.string(),
  pairingCode: z.string().nullable(),
  pairingQrDataUrl: z.string().nullable(),
  sessionAgeDays: z.number().int().nonnegative(),
  todayStats: z.object({
    sent: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    delivered: z.number().int().nonnegative(),
    read: z.number().int().nonnegative(),
    resetAt: z.date(),
  }),
});
export type WorkerState = z.infer<typeof WorkerStateSchema>;

// ----- chat_events -----

export const ChatEventDirectionSchema = z.enum(['in', 'out_device', 'in_history', 'out_history']);
export type ChatEventDirection = z.infer<typeof ChatEventDirectionSchema>;

export const ChatEventSourceSchema = z.enum(['live', 'history_sync']);
export type ChatEventSource = z.infer<typeof ChatEventSourceSchema>;

export const ChatEventContentSchema = z.object({
  kind: z.enum(['text', 'image', 'document', 'audio', 'video', 'sticker', 'other']),
  text: z.string().optional(),
  media: z
    .object({
      kind: z.enum(['image', 'document', 'audio', 'video', 'sticker']),
      caption: z.string().optional(),
      filename: z.string().optional(),
      unavailable: z.boolean(),
    })
    .optional(),
});
export type ChatEventContent = z.infer<typeof ChatEventContentSchema>;

export const ChatEventDocSchema = z.object({
  sessionId: SessionIdSchema,
  workerId: z.string().min(1),
  waMessageId: z.string().min(1),
  direction: ChatEventDirectionSchema,
  source: ChatEventSourceSchema,
  counterpartyJid: z.string().min(1),
  counterpartyE164: E164Schema.nullable(),
  content: ChatEventContentSchema,
  ts: z.date(),
  ingestedAt: z.date(),
});
export type ChatEventDoc = z.infer<typeof ChatEventDocSchema>;

// ----- message_revisions -----

/**
 * Body shape carried on an edit revision. Mirrors the editable surface of a
 * WhatsApp message, text edits are by far the most common, but caption edits
 * on media are possible. Stickers / audio / video / "other" are present so a
 * worker that observes a revision on those kinds can still record the event
 * without a content type that doesn't fit the union.
 */
export const MessageRevisionBodySchema = z.discriminatedUnion('kind', [
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
export type MessageRevisionBody = z.infer<typeof MessageRevisionBodySchema>;

export const MessageRevisionKindSchema = z.enum(['edit', 'delete']);
export type MessageRevisionKind = z.infer<typeof MessageRevisionKindSchema>;

export const MessageRevisionDeletedBySchema = z.enum(['self', 'sender', 'admin']);
export type MessageRevisionDeletedBy = z.infer<typeof MessageRevisionDeletedBySchema>;

export const MessageRevisionSourceSchema = z.enum(['live', 'history']);
export type MessageRevisionSource = z.infer<typeof MessageRevisionSourceSchema>;

/**
 * Append-only revision row. `revisionSeq` is monotonic per `messageId`
 * (or per `waMessageId` when the gateway-side UUID hasn't been resolved
 * yet), starting at 1, the original message is implicitly seq 0.
 *
 * `messageId` is nullable because the worker emits revisions keyed only on
 * `waMessageId`; the gateway resolves the gateway UUID at insert via
 * `messages.findByWaMessageId`, but a revision can land before the original
 * `chat_event` is persisted (race). The viewer aggregation reconciles via
 * the `waMessageId` lookup index in that case.
 *
 * Edits carry the new body; deletes carry no body but record who deleted
 * (self / sender / admin). Wire timestamps are ISO 8601; the gateway
 * converts to `Date` only inside repositories that actually persist `Date`
 * columns elsewhere, these stay as strings so the wire shape and the
 * stored shape are identical.
 */
export const MessageRevisionDocBaseSchema = z.object({
  sessionId: SessionIdSchema,
  messageId: z.string().uuid().nullable(),
  /** Raw WhatsApp message id; persisted alongside `messageId` for the
   *  lookup-only index that resolves null-messageId rows in the viewer. */
  waMessageId: z.string().min(1),
  revisionSeq: z.number().int().min(1),
  kind: MessageRevisionKindSchema,
  body: MessageRevisionBodySchema.optional(),
  deletedBy: MessageRevisionDeletedBySchema.optional(),
  ts: z.string().datetime({ offset: true }),
  capturedAt: z.string().datetime({ offset: true }),
  source: MessageRevisionSourceSchema,
});

const messageRevisionRefinement = (
  data: {
    kind: MessageRevisionKind;
    body?: MessageRevisionBody;
    deletedBy?: MessageRevisionDeletedBy;
  },
  ctx: z.RefinementCtx,
): void => {
  if (data.kind === 'edit') {
    if (!data.body) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['body'],
        message: "body is required when kind is 'edit'",
      });
    }
  } else {
    // kind === 'delete'
    if (data.body) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['body'],
        message: "body must be absent when kind is 'delete'",
      });
    }
    if (!data.deletedBy) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['deletedBy'],
        message: "deletedBy is required when kind is 'delete'",
      });
    }
  }
};

export const MessageRevisionDocSchema =
  MessageRevisionDocBaseSchema.superRefine(messageRevisionRefinement);
export type MessageRevisionDoc = z.infer<typeof MessageRevisionDocSchema>;

// ----- contacts -----

/**
 * Per-session contact-book row. Replace-on-conflict on `(sessionId, e164)`, * not append-only; the latest snapshot wins. Distinct from `ChatContactDoc`,
 * which is a denormalised projection used by the legacy thread aggregation.
 */
export const ContactSourceSchema = z.enum(['history', 'live']);
export type ContactSource = z.infer<typeof ContactSourceSchema>;

export const ContactDocBaseSchema = z.object({
  sessionId: SessionIdSchema,
  e164: E164Schema,
  waJid: z.string().min(1),
  displayName: z.string().min(1).max(200).optional(),
  pushName: z.string().min(1).max(200).optional(),
  profilePictureUrl: z.string().url().optional(),
  isBusiness: z.boolean(),
  lastSeenAt: z.string().datetime({ offset: true }).optional(),
  capturedAt: z.string().datetime({ offset: true }),
  source: ContactSourceSchema,
});

export const ContactDocSchema = ContactDocBaseSchema;
export type ContactDoc = z.infer<typeof ContactDocSchema>;

// ----- message_reactions -----

/**
 * Per-peer reaction snapshot. Replace-on-conflict on
 * `(sessionId, waMessageId, fromJid)`, one row per peer per target message;
 * the latest reaction wins. Empty `emoji` keeps the row in place as an audit
 * record of a cleared reaction (the row stays; the displayed pill is
 * filtered out at projection time).
 *
 * Note: this is NOT append-only. `message_revisions` carries audit history
 * for edits/deletes; reactions are intentionally last-write-wins because
 * WhatsApp itself only surfaces the most-recent emoji per peer.
 */
export const MessageReactionDocSchema = z.object({
  sessionId: SessionIdSchema,
  /** Target message's WhatsApp id. */
  waMessageId: z.string().min(1),
  /** Resolved gateway UUID when the target was outbound (`targetFromMe`). */
  messageId: z.string().uuid().optional(),
  /** Mirrors the wire field; required for read-side joins where we discriminate
   *  outbound vs inbound targets without re-resolving. */
  targetFromMe: z.boolean(),
  /** Raw Baileys JID of the reactor. */
  fromJid: z.string().min(1),
  /** Reactor E.164, `null` for groups where the JID isn't `@s.whatsapp.net`. */
  fromE164: E164Schema.nullable(),
  /** Empty string represents a cleared reaction; the row remains for audit. */
  emoji: z.string().max(8),
  ts: z.string().datetime({ offset: true }),
  capturedAt: z.string().datetime({ offset: true }),
});
export type MessageReactionDoc = z.infer<typeof MessageReactionDocSchema>;

// ----- chat_contacts -----

export const ChatContactDocSchema = z.object({
  sessionId: SessionIdSchema,
  jid: z.string().min(1),
  e164: E164Schema.nullable(),
  pushName: z.string().nullable(),
  notify: z.string().nullable(),
  verifiedName: z.string().nullable(),
  profilePicUrl: z.string().nullable(),
  updatedAt: z.date(),
});
export type ChatContactDoc = z.infer<typeof ChatContactDocSchema>;

// ----- groups -----

/**
 * A single entry in `GroupMetadata.participants`, normalised from Baileys'
 * `GroupParticipant` (which extends `Contact`). We keep only `jid` plus the
 * admin role; the wider contact fields (name, notify, profile picture) are
 * covered separately by `ContactDocSchema` and would duplicate storage here.
 * `admin` mirrors Baileys exactly, including the `null` case it uses for "a
 * plain member" as distinct from `undefined` ("role unknown").
 */
export const GroupParticipantRoleSchema = z.enum(['admin', 'superadmin']);
export type GroupParticipantRole = z.infer<typeof GroupParticipantRoleSchema>;

export const GroupParticipantSchema = z.object({
  jid: z.string().min(1),
  admin: GroupParticipantRoleSchema.nullable().optional(),
});
export type GroupParticipant = z.infer<typeof GroupParticipantSchema>;

/**
 * Shared shape for Baileys `GroupMetadata`, used both on the wire
 * (worker → gateway push) and at rest (the `groups` collection). Every field
 * bar the group `jid` is optional: WA omits plenty depending on the group
 * and on whether the worker fetched full metadata or only a partial update.
 *
 * Numeric unix-timestamp fields on the Baileys type (`creation`,
 * `subjectTime`) are normalised to ISO 8601 strings with offset at the wire
 * boundary, matching `ChatEventSchema.ts` above, the raw type is `number`
 * seconds-since-epoch, which is easy to mishandle downstream.
 */
export const GroupMetadataSchema = z.object({
  /** WhatsApp group JID, e.g. `120363012345678901@g.us`. */
  jid: z.string().min(1),
  subject: z.string().optional(),
  /** JID of whoever last changed the subject. */
  subjectOwner: z.string().optional(),
  subjectTime: z.string().datetime({ offset: true }).optional(),
  creation: z.string().datetime({ offset: true }).optional(),
  /** Group owner JID; Baileys omits this for some group types (e.g. community-linked groups). */
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
  participants: z.array(GroupParticipantSchema).optional(),
});
export type GroupMetadata = z.infer<typeof GroupMetadataSchema>;

/**
 * `groups` collection: one row per `(sessionId, jid)`, replace-on-conflict, * the latest fetch wins, there is no history. `fetchedAt` records when the
 * worker captured this snapshot, distinct from any of the metadata's own
 * timestamps, so the gateway can reason about staleness independently of
 * whether WA actually changed anything.
 */
export const GroupDocSchema = GroupMetadataSchema.extend({
  sessionId: SessionIdSchema,
  fetchedAt: z.string().datetime({ offset: true }),
});
export type GroupDoc = z.infer<typeof GroupDocSchema>;

// ----- settings -----

export const SettingsSchema = z.object({
  _id: z.literal('singleton'),
  throttle: z.object({
    minIntervalMsPerJid: z.number().int().min(0).max(60_000),
    minIntervalMsGlobal: z.number().int().min(0).max(60_000),
    jitterMs: z.number().int().min(0).max(10_000),
  }),
  caps: z.object({
    perHour: z.number().int().positive(),
    perDay: z.number().int().positive(),
  }),
  contentDenylistRegex: z.array(z.string()),
  allowedMediaMimeTypes: z.array(z.string()),
  webhookMaxRetries: z.number().int().min(0).max(20),
  adminEmails: z.array(z.string().email()),
  attackMode: z.boolean(),
  maintenanceMode: z.boolean(),
  updatedAt: z.date(),
  updatedBy: z.string(),
});
export type Settings = z.infer<typeof SettingsSchema>;

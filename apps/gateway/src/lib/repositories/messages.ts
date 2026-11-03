/**
 * Message repository.
 */
import 'server-only';
import type { Document, ObjectId } from 'mongodb';
import type { MessagePurpose, ProjectId } from '@hmddevs/protocol';
import { col, chatEvents } from '../mongo';

/** Escape user-supplied strings before injecting into a Mongo `$regex` filter. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export type MessageStatus =
  | 'queued'
  | 'scheduled'
  | 'sent'
  | 'delivered'
  | 'read'
  | 'failed'
  | 'expired';

export interface StatusEvent {
  status: MessageStatus;
  at: Date;
  code?: string;
  detail?: string;
}

export interface MessageDoc {
  _id?: ObjectId;
  messageId: string; // uuid, public id
  apiKeyId: string;
  /**
   * Tenant slug, copied from `apiKey.projectId` at send-time (never from the
   * request body). For admin-originated sends the sentinel `admin-console` is
   * used, see `api/admin/sessions/[id]/send/route.ts`.
   */
  projectId: ProjectId;
  /**
   * Caller-declared intent (otp, transactional, marketing, …). Required, * distinct from `channel`, which gates scope and worker throttling.
   */
  purpose: MessagePurpose;
  to: string; // E.164 normalised
  channel: 'notification' | 'transactional' | 'internal';
  body:
    | { kind: 'text'; text: string }
    | { kind: 'image'; url: string; caption?: string }
    | { kind: 'document'; url: string; filename?: string; caption?: string };
  idempotencyKey?: string | null;
  status: MessageStatus;
  statusHistory: StatusEvent[];
  waMessageId?: string | null;
  workerId: string;
  sessionId: string;
  /**
   * Organization the sending key is bound to, when it is. Carried so that a
   * SCHEDULED message can be routed at dispatch time rather than at enqueue:
   * the number chosen an hour ahead may be dead or out of budget by the time
   * the cron fires. Absent for keys bound directly to a session.
   */
  orgId?: string;
  createdAt: Date;
  ttlExpiresAt: Date; // message drops after this if still queued
  requestId: string;
  errorCode?: string;
  errorDetail?: string;
  /** Set when status is 'scheduled'; null on immediate sends. */
  scheduledFor?: Date | null;
  /** Set by the scheduled-dispatch cron when a scheduled message is published. */
  dispatchedAt?: Date | null;
  /** 'api' for SDK/API sends; 'admin' for sends from the admin dashboard. */
  origin?: 'api' | 'admin';
  /**
   * Captured reply target for outbound messages that quote a prior message.
   * `messageId` is the caller-supplied gateway UUID of the quoted original
   * (always outbound on this code path, we don't yet allow quoting inbound).
   * `waMessageId` and `fromMe` are stamped from `findReplyTarget` at send
   * time so the viewer can render the quote chrome without a second lookup.
   */
  replyTo?: {
    messageId: string;
    waMessageId: string;
    fromMe: true;
  };
}

export async function insertMessage(doc: MessageDoc): Promise<void> {
  const c = await col<MessageDoc>('messages');
  await c.insertOne(doc);
}

export async function findByMessageId(messageId: string): Promise<MessageDoc | null> {
  const c = await col<MessageDoc>('messages');
  return c.findOne({ messageId });
}

export async function findByIdempotency(
  apiKeyId: string,
  idempotencyKey: string,
): Promise<MessageDoc | null> {
  const c = await col<MessageDoc>('messages');
  return c.findOne({ apiKeyId, idempotencyKey });
}

export async function updateStatus(
  messageId: string,
  event: StatusEvent,
  extra?: Partial<Pick<MessageDoc, 'waMessageId' | 'errorCode' | 'errorDetail'>>,
): Promise<void> {
  const c = await col<MessageDoc>('messages');
  await c.updateOne(
    { messageId },
    {
      $set: {
        status: event.status,
        ...(extra ?? {}),
      },
      $push: { statusHistory: event },
    },
  );
}

export async function listByApiKey(
  apiKeyId: string,
  opts: { limit?: number; beforeId?: string } = {},
): Promise<MessageDoc[]> {
  const c = await col<MessageDoc>('messages');
  const limit = Math.min(opts.limit ?? 50, 200);
  const q: Record<string, unknown> = { apiKeyId };
  if (opts.beforeId) {
    const anchor = await c.findOne({ messageId: opts.beforeId }, { projection: { createdAt: 1 } });
    if (anchor) q.createdAt = { $lt: anchor.createdAt };
  }
  return c.find(q).sort({ createdAt: -1 }).limit(limit).toArray();
}

/**
 * Resolve a reply target for outbound quoting. Returns the WhatsApp message
 * key only when:
 *   1. A message with this gateway `messageId` exists in the given session.
 *   2. The worker has acknowledged the send (`waMessageId` is populated).
 *
 * `fromMe` is hard-coded to `true` because we currently only allow replies to
 * messages we sent. Replying to inbound messages is reserved for a later slice
 *, that path would need to look up `inbound_messages` and resolve the peer
 * `participantJid` for groups (groups also deferred).
 */
export async function findReplyTarget(
  /**
   * Where the quoted original is allowed to have come from. An organization
   * key has no meaningful bound session, the original could have been sent
   * from any member number, so scoping such a lookup to one session would
   * 404 every reply. Scope by `orgId` for those, `sessionId` otherwise.
   */
  scope: { sessionId: string } | { orgId: string },
  messageId: string,
): Promise<{ waMessageId: string; fromMe: true } | null> {
  const c = await col<MessageDoc>('messages');
  const doc = await c.findOne({ messageId, ...scope }, { projection: { waMessageId: 1 } });
  if (!doc?.waMessageId) return null;
  return { waMessageId: doc.waMessageId, fromMe: true };
}

/**
 * Look up the gateway-side message by its WhatsApp message id within a session.
 * Used by the worker callback to map `reaction` events back onto the original
 * outbound message for webhook fan-out.
 */
export async function findByWaMessageId(
  sessionId: string,
  waMessageId: string,
): Promise<MessageDoc | null> {
  const c = await col<MessageDoc>('messages');
  return c.findOne({ sessionId, waMessageId });
}

/**
 * Pull scheduled messages whose `scheduledFor` is now-due. Sorted oldest-first
 * so cron sweeps drain the backlog deterministically.
 */
export async function findDueScheduled(limit = 50): Promise<MessageDoc[]> {
  const c = await col<MessageDoc>('messages');
  return c
    .find({ status: 'scheduled', scheduledFor: { $lte: new Date() } })
    .sort({ scheduledFor: 1 })
    .limit(Math.min(Math.max(limit, 1), 500))
    .toArray();
}

/**
 * Atomically claim one due scheduled message by transitioning it
 * from `scheduled → queued` in a single findOneAndUpdate. Returns null
 * when the queue is empty or all due messages have already been claimed
 * by a concurrent invocation. The cron drain loop calls this in a while
 * loop so concurrent Vercel invocations cannot double-dispatch.
 */
export async function claimOneDueScheduled(at: Date = new Date()): Promise<MessageDoc | null> {
  const c = await col<MessageDoc>('messages');
  return c.findOneAndUpdate(
    { status: 'scheduled', scheduledFor: { $lte: at } },
    {
      $set: { status: 'queued', dispatchedAt: at },
      $push: { statusHistory: { status: 'queued', at } as StatusEvent },
    },
    { sort: { scheduledFor: 1 }, returnDocument: 'before' },
  );
}

/**
 * Mark a scheduled message as dispatched (status 'queued' + dispatchedAt set).
 * Used exclusively by the scheduled-dispatch cron.
 */
export async function markDispatched(messageId: string, at: Date = new Date()): Promise<void> {
  const c = await col<MessageDoc>('messages');
  await c.updateOne(
    { messageId },
    {
      $set: { status: 'queued', dispatchedAt: at },
      $push: { statusHistory: { status: 'queued', at } as StatusEvent },
    },
  );
}

/**
 * Mark a scheduled message as failed (e.g. session vanished before dispatch).
 */
export async function markFailedFromSchedule(
  messageId: string,
  reason: string,
  at: Date = new Date(),
): Promise<void> {
  const c = await col<MessageDoc>('messages');
  await c.updateOne(
    { messageId },
    {
      $set: { status: 'failed', errorCode: 'SCHEDULED_DISPATCH_FAILED', errorDetail: reason },
      $push: {
        statusHistory: {
          status: 'failed',
          at,
          code: 'SCHEDULED_DISPATCH_FAILED',
          detail: reason,
        } as StatusEvent,
      },
    },
  );
}

/**
 * Re-stamp the number a message will be sent from. Used by scheduled dispatch
 * when an organization message is routed at fire time: the ack path, the
 * viewer and the worker's pending list all key off `sessionId`, so they have
 * to agree with whoever actually takes the send.
 */
export async function restampRouting(
  messageId: string,
  sessionId: string,
  workerId: string,
): Promise<void> {
  const c = await col<MessageDoc>('messages');
  await c.updateOne({ messageId }, { $set: { sessionId, workerId } });
}

/**
 * Count messages stuck in `queued` past the given cutoff. A message stays
 * `queued` until the worker sends it; a non-zero count older than a few minutes
 * means the worker is publishing-but-deaf (half-open subscription) or down, * the alarm path in the reap cron. `dispatchedAt: null` matches both an
 * explicit null and a missing field, so immediate sends (no `dispatchedAt`) are
 * included alongside dispatched-but-stuck scheduled sends.
 */
export async function countStalledQueued(olderThan: Date): Promise<number> {
  const c = await col<MessageDoc>('messages');
  return c.countDocuments({
    status: 'queued',
    dispatchedAt: null,
    createdAt: { $lt: olderThan },
  });
}

export async function reapExpired(now: Date = new Date()): Promise<number> {
  const c = await col<MessageDoc>('messages');
  const r = await c.updateMany(
    { status: 'queued', ttlExpiresAt: { $lt: now } },
    {
      $set: { status: 'expired', errorCode: 'TTL_EXPIRED' },
      $push: {
        statusHistory: { status: 'expired', at: now, code: 'TTL_EXPIRED' } as StatusEvent,
      },
    },
  );
  return r.modifiedCount;
}

// ---------------------------------------------------------------------------
// Admin conversation viewer aggregations
//
// A "thread" is the tuple `(sessionId, counterparty E.164)`. Both functions
// below union the outbound `messages` collection with the inbound
// `inbound_messages` collection into a single shape, then either group by
// counterparty (thread list) or stream messages newest-first (thread view).
// ---------------------------------------------------------------------------

const PREVIEW_MAX = 120;

export interface AdminThreadSummaryDoc {
  counterparty: string;
  /** `'dm'` for one-to-one threads, `'group'` for `…@g.us` threads. */
  type: 'dm' | 'group';
  /** Set only for groups, the raw group JID. */
  counterpartyJid?: string;
  lastMessageAt: Date;
  lastMessagePreview: string;
  lastMessageDirection: 'in' | 'out';
  lastMessageStatus?: MessageStatus;
  unreadCount: number;
  /** Internal, used to seed the next-page cursor. Equals counterparty for now. */
  _cursorId: string;
}

/**
 * List threads for one session, newest-activity first. Uses Mongo `$unionWith`
 * across `messages` and `inbound_messages` to build a unified per-message
 * stream, groups by counterparty, then attaches an `unreadCount` via
 * `$lookup` over `inbound_messages` filtered by `receivedAt > lastOutboundAt`.
 *
 * Pagination is `(lastMessageAt, counterparty)` cursor; limit defaults to 50,
 * caps at 100. Search applies post-group: case-insensitive substring on the
 * counterparty E.164 OR the latest message preview. Search strings shorter
 * than 2 characters are ignored.
 */
export async function listThreadsForSession(
  sessionId: string,
  opts: {
    cursor?: { ts: Date; id: string } | null;
    search?: string;
    limit?: number;
  } = {},
): Promise<{ items: AdminThreadSummaryDoc[]; nextCursor: { ts: Date; id: string } | null }> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
  const fetchSize = limit + 1;

  // Outbound projection: previews from text/caption/filename, status from doc.
  const outboundProject: Document = {
    $project: {
      _id: 1,
      counterparty: '$to',
      type: { $literal: 'dm' },
      counterpartyJid: { $literal: null },
      ts: '$createdAt',
      direction: { $literal: 'out' },
      status: '$status',
      outTs: '$createdAt',
      preview: {
        $switch: {
          branches: [
            { case: { $eq: ['$body.kind', 'text'] }, then: { $ifNull: ['$body.text', ''] } },
            {
              case: { $eq: ['$body.kind', 'image'] },
              then: { $ifNull: ['$body.caption', { $ifNull: ['$body.filename', ''] }] },
            },
            {
              case: { $eq: ['$body.kind', 'document'] },
              then: { $ifNull: ['$body.caption', { $ifNull: ['$body.filename', ''] }] },
            },
          ],
          default: '',
        },
      },
    },
  };

  // Inbound projection: `content.kind` instead of `body.kind`, no status.
  // why: `from` is the raw Baileys JID; `fromE164` is the E.164 the viewer
  // expects as a thread key. Rows missing `fromE164` (groups, malformed JIDs)
  // are excluded by the upstream `$match` in the union pipeline.
  const inboundProject: Document = {
    $project: {
      _id: 1,
      counterparty: '$fromE164',
      type: { $literal: 'dm' },
      counterpartyJid: { $literal: null },
      ts: '$receivedAt',
      direction: { $literal: 'in' },
      status: { $literal: null },
      outTs: { $literal: null },
      preview: {
        $switch: {
          branches: [
            {
              case: { $eq: ['$content.kind', 'text'] },
              then: { $ifNull: ['$content.text', ''] },
            },
            {
              case: { $eq: ['$content.kind', 'image'] },
              then: { $ifNull: ['$content.caption', { $ifNull: ['$content.mediaFileName', ''] }] },
            },
            {
              case: { $eq: ['$content.kind', 'document'] },
              then: { $ifNull: ['$content.caption', { $ifNull: ['$content.mediaFileName', ''] }] },
            },
          ],
          default: '',
        },
      },
    },
  };

  // Chat-events projection: covers device-side outbound (`out_device`),
  // outbound history (`out_history`), and inbound history (`in_history`).
  // why: PR-2 widens the source from out_device-only to also include the two
  // history-sync directions so imported chats render in the viewer. The
  // `direction` field is collapsed to the unified `'in' | 'out'` shape, // `in_history` → `'in'`, the `out_*` flavours → `'out'`. Group rows have
  // `counterpartyE164: null` and are filtered out (separate viewer concern).
  // `outTs` is left null for inbound rows so they don't reset the unread
  // threshold; the unread heuristic still reads from `inbound_messages` only,
  // so `chat_events` rows never contribute to unread counts (history-imported
  // inbound was already read on the original device).
  const chatEventProject: Document = {
    $project: {
      _id: 1,
      counterparty: '$counterpartyE164',
      type: { $literal: 'dm' },
      counterpartyJid: { $literal: null },
      ts: '$ts',
      direction: {
        $cond: [{ $eq: ['$direction', 'in_history'] }, 'in', 'out'],
      },
      status: { $literal: null },
      outTs: {
        $cond: [{ $eq: ['$direction', 'in_history'] }, null, '$ts'],
      },
      preview: {
        $ifNull: [
          '$content.text',
          { $ifNull: ['$content.media.caption', { $ifNull: ['$content.media.filename', ''] }] },
        ],
      },
    },
  };

  // Group projection: keyed by `counterpartyJid` (groups have
  // `counterpartyE164: null`). Direction collapses both `'in'`/`'in_history'`
  // → `'in'` and `'out_device'`/`'out_history'` → `'out'`. Group threads do
  // not contribute to unread counts (see lookup-skip below), so `outTs` is
  // left null to avoid touching the heuristic at all.
  const groupChatEventProject: Document = {
    $project: {
      _id: 1,
      counterparty: '$counterpartyJid',
      type: { $literal: 'group' },
      counterpartyJid: '$counterpartyJid',
      ts: '$ts',
      direction: {
        $cond: [{ $in: ['$direction', ['in', 'in_history']] }, 'in', 'out'],
      },
      status: { $literal: null },
      outTs: { $literal: null },
      preview: {
        $ifNull: [
          '$content.text',
          { $ifNull: ['$content.media.caption', { $ifNull: ['$content.media.filename', ''] }] },
        ],
      },
    },
  };

  const pipeline: Document[] = [
    { $match: { sessionId } },
    outboundProject,
    {
      $unionWith: {
        coll: 'inbound_messages',
        pipeline: [{ $match: { sessionId, fromE164: { $ne: null } } }, inboundProject],
      },
    },
    {
      $unionWith: {
        coll: 'chat_events',
        pipeline: [
          {
            $match: {
              sessionId,
              direction: { $in: ['out_device', 'out_history', 'in_history'] },
              counterpartyE164: { $ne: null },
            },
          },
          chatEventProject,
        ],
      },
    },
    // Group conversations: same `chat_events` collection but matched on
    // `counterpartyE164: null` (groups never resolve to an E.164) and
    // including live inbound (`'in'`), DMs receive live inbound via
    // `inbound_messages`, but groups don't, so `chat_events` is the only
    // surface that carries them.
    {
      $unionWith: {
        coll: 'chat_events',
        pipeline: [
          {
            $match: {
              sessionId,
              counterpartyE164: null,
              direction: { $in: ['in', 'out_device', 'in_history', 'out_history'] },
              // $regex only matches non-null strings, so $ne:null is implicit.
              // This excludes broadcast/newsletter/status JIDs that also have
              // counterpartyE164:null but are not WhatsApp group threads.
              counterpartyJid: { $regex: '@g\\.us$' },
            },
          },
          groupChatEventProject,
        ],
      },
    },
    { $sort: { ts: -1, _id: -1 } },
    {
      $group: {
        _id: '$counterparty',
        type: { $first: '$type' },
        counterpartyJid: { $first: '$counterpartyJid' },
        lastMessageAt: { $first: '$ts' },
        lastMessagePreview: { $first: '$preview' },
        lastMessageDirection: { $first: '$direction' },
        lastMessageStatus: { $first: '$status' },
        lastOutboundAt: { $max: '$outTs' },
      },
    },
    {
      $project: {
        _id: 0,
        counterparty: '$_id',
        type: 1,
        counterpartyJid: 1,
        lastMessageAt: 1,
        lastMessagePreview: {
          $substrCP: [{ $ifNull: ['$lastMessagePreview', ''] }, 0, PREVIEW_MAX],
        },
        lastMessageDirection: 1,
        lastMessageStatus: 1,
        lastOutboundAt: 1,
        _cursorId: '$_id',
      },
    },
  ];

  const search = (opts.search ?? '').trim();
  if (search.length >= 2) {
    const rx = { $regex: escapeRegex(search), $options: 'i' };
    pipeline.push({
      $match: {
        $or: [{ counterparty: rx }, { lastMessagePreview: rx }],
      },
    });
  }

  if (opts.cursor) {
    pipeline.push({
      $match: {
        $or: [
          { lastMessageAt: { $lt: opts.cursor.ts } },
          { lastMessageAt: opts.cursor.ts, _cursorId: { $lt: opts.cursor.id } },
        ],
      },
    });
  }

  pipeline.push({ $sort: { lastMessageAt: -1, _cursorId: -1 } }, { $limit: fetchSize });

  // Attach unread count: inbound messages from this counterparty whose
  // `receivedAt` is strictly newer than the last outbound `createdAt`. When
  // there has never been an outbound message, treat the threshold as the
  // epoch so every inbound counts as unread.
  pipeline.push({
    $lookup: {
      from: 'inbound_messages',
      let: {
        cp: '$counterparty',
        lastOut: { $ifNull: ['$lastOutboundAt', new Date(0)] },
      },
      pipeline: [
        {
          $match: {
            $expr: {
              $and: [
                { $eq: ['$sessionId', sessionId] },
                // why: `$$cp` is now an E.164 (the unified counterparty key),
                // so we join on `fromE164` not the raw JID `from`.
                { $eq: ['$fromE164', '$$cp'] },
                { $gt: ['$receivedAt', '$$lastOut'] },
              ],
            },
          },
        },
        { $count: 'n' },
      ],
      as: 'unread',
    },
  });
  pipeline.push({
    $addFields: {
      unreadCount: {
        $ifNull: [{ $arrayElemAt: ['$unread.n', 0] }, 0],
      },
    },
  });
  pipeline.push({ $project: { unread: 0, lastOutboundAt: 0 } });

  const c = await col('messages');
  const rows = (await c.aggregate(pipeline).toArray()) as Array<{
    counterparty: string;
    type?: 'dm' | 'group' | null;
    counterpartyJid?: string | null;
    lastMessageAt: Date;
    lastMessagePreview: string;
    lastMessageDirection: 'in' | 'out';
    lastMessageStatus?: MessageStatus | null;
    unreadCount: number;
    _cursorId: string;
  }>;

  let nextCursor: { ts: Date; id: string } | null = null;
  if (rows.length > limit) {
    const anchor = rows[limit - 1]!;
    nextCursor = { ts: anchor.lastMessageAt, id: anchor._cursorId };
    rows.length = limit;
  }

  const items: AdminThreadSummaryDoc[] = rows.map((r) => ({
    counterparty: r.counterparty,
    // why: pre-group-support documents and tests projected only `'dm'` rows
    // without an explicit `type`; default to `'dm'` so existing fixtures are
    // unaffected and new group rows surface as `'group'`.
    type: r.type ?? 'dm',
    ...(r.counterpartyJid ? { counterpartyJid: r.counterpartyJid } : {}),
    lastMessageAt: r.lastMessageAt,
    lastMessagePreview: r.lastMessagePreview ?? '',
    lastMessageDirection: r.lastMessageDirection,
    ...(r.lastMessageDirection === 'out' && r.lastMessageStatus
      ? { lastMessageStatus: r.lastMessageStatus }
      : {}),
    unreadCount: r.unreadCount,
    _cursorId: r._cursorId,
  }));

  return { items, nextCursor };
}

export interface AdminThreadMessageRevision {
  revisionSeq: number;
  kind: 'edit' | 'delete';
  body?:
    | { kind: 'text'; text: string }
    | { kind: 'image'; caption?: string; mediaFileName?: string }
    | { kind: 'document'; caption?: string; mediaFileName?: string }
    | { kind: 'audio' | 'video' | 'sticker' | 'other' };
  deletedBy?: 'self' | 'sender' | 'admin';
  ts: string;
}

export interface AdminThreadMessageReplyTo {
  messageId: string | null;
  waMessageId: string;
  fromMe: boolean;
  /** Truncated text/caption excerpt of the original; absent if the original
   *  is missing from our store. */
  bodyPreview?: string;
}

export interface AdminThreadMessageReaction {
  fromJid: string;
  fromE164: string | null;
  emoji: string;
  ts: string;
}

export interface AdminThreadMessageDoc {
  messageId: string;
  direction: 'in' | 'out';
  ts: Date;
  body:
    | { kind: 'text'; text: string }
    | { kind: 'image'; caption?: string; mediaFileName?: string }
    | { kind: 'document'; caption?: string; mediaFileName?: string }
    | { kind: 'audio' | 'video' | 'sticker' | 'other' };
  status?: MessageStatus;
  /** Internal, `_id.toString()` of the underlying source doc. */
  _cursorId: string;
  /** Append-only edit/delete history, ordered by `revisionSeq` ascending. */
  revisions?: AdminThreadMessageRevision[];
  /** Body text after the latest edit revision. Absent when the latest revision is a delete. */
  latestBody?: AdminThreadMessageDoc['body'];
  /** ISO 8601 of the latest `kind: 'edit'` revision. */
  editedAt?: string;
  /** ISO 8601 of the latest `kind: 'delete'` revision. */
  deletedAt?: string;
  /** Quoted-original reference for the WhatsApp Web reply chrome. */
  replyTo?: AdminThreadMessageReplyTo;
  /** Per-peer reactions, sorted by `ts` ascending; cleared rows filtered out. */
  reactions?: AdminThreadMessageReaction[];
}

/**
 * Stream all messages between this session and one counterparty, newest-first.
 * Caller (route or UI) reverses the slice for chronological display. Cursor
 * pagination keys on `(ts, _id)` to break ties between same-millisecond
 * inserts.
 */
export async function listThreadMessages(
  sessionId: string,
  counterparty: string,
  opts: { cursor?: { ts: Date; id: string } | null; limit?: number } = {},
): Promise<{ items: AdminThreadMessageDoc[]; nextCursor: { ts: Date; id: string } | null }> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
  const fetchSize = limit + 1;

  const outboundProject: Document = {
    $project: {
      _id: 1,
      _cursorId: { $toString: '$_id' },
      messageId: '$messageId',
      // why: keep the stored WhatsApp id under a stable union-shape field so
      // the reactions $lookup can join on it. Outbound stores it separately
      // (UUID is `messageId`); chat_events `messageId` is already the WA id;
      // inbound has no WA-side reactions on the current capture path.
      waMessageId: { $ifNull: ['$waMessageId', null] },
      direction: { $literal: 'out' },
      ts: '$createdAt',
      status: '$status',
      // why: surface the captured replyTo so the viewer can render quote
      // chrome. Stored at send-time on outbound messages only; inbound and
      // chat_event rows project null and are dropped post-aggregation.
      replyTo: '$replyTo',
      body: {
        $switch: {
          branches: [
            {
              case: { $eq: ['$body.kind', 'text'] },
              then: { kind: 'text', text: { $ifNull: ['$body.text', ''] } },
            },
            {
              case: { $eq: ['$body.kind', 'image'] },
              then: {
                kind: 'image',
                caption: '$body.caption',
                mediaFileName: '$body.filename',
              },
            },
            {
              case: { $eq: ['$body.kind', 'document'] },
              then: {
                kind: 'document',
                caption: '$body.caption',
                mediaFileName: '$body.filename',
              },
            },
          ],
          default: { kind: 'other' },
        },
      },
    },
  };

  const inboundProject: Document = {
    $project: {
      _id: 1,
      _cursorId: { $toString: '$_id' },
      messageId: '$inboundId',
      waMessageId: { $ifNull: ['$waMessageId', null] },
      direction: { $literal: 'in' },
      ts: '$receivedAt',
      status: { $literal: null },
      // why: inbound quoted-reply refs are not currently captured by the
      // worker (Baileys `contextInfo.stanzaId` is dropped). Surface null so
      // the viewer projects no replyTo for inbound rows. Documented gap.
      replyTo: { $literal: null },
      body: {
        $switch: {
          branches: [
            {
              case: { $eq: ['$content.kind', 'text'] },
              then: { kind: 'text', text: { $ifNull: ['$content.text', ''] } },
            },
            {
              case: { $eq: ['$content.kind', 'image'] },
              then: {
                kind: 'image',
                caption: '$content.caption',
                mediaFileName: '$content.mediaFileName',
              },
            },
            {
              case: { $eq: ['$content.kind', 'document'] },
              then: {
                kind: 'document',
                caption: '$content.caption',
                mediaFileName: '$content.mediaFileName',
              },
            },
            { case: { $eq: ['$content.kind', 'audio'] }, then: { kind: 'audio' } },
            { case: { $eq: ['$content.kind', 'video'] }, then: { kind: 'video' } },
            { case: { $eq: ['$content.kind', 'sticker'] }, then: { kind: 'sticker' } },
          ],
          default: { kind: 'other' },
        },
      },
    },
  };

  // Chat-events projection: device-side outbound + history-sync (both
  // directions) keyed by `counterpartyE164`. Direction is collapsed to the
  // unified `'in' | 'out'` shape, `in_history` → `'in'`, `out_*` → `'out'`.
  // Body kinds match the inbound projection's variants.
  const chatEventProject: Document = {
    $project: {
      _id: 1,
      _cursorId: { $toString: '$_id' },
      messageId: '$waMessageId',
      waMessageId: '$waMessageId',
      direction: {
        $cond: [{ $eq: ['$direction', 'in_history'] }, 'in', 'out'],
      },
      ts: '$ts',
      status: { $literal: null },
      // why: chat_events rows don't carry replyTo; only outbound `messages`
      // store it (set at send-time). Project null here so the union shape
      // stays uniform.
      replyTo: { $literal: null },
      body: {
        $switch: {
          branches: [
            {
              case: { $eq: ['$content.kind', 'text'] },
              then: { kind: 'text', text: { $ifNull: ['$content.text', ''] } },
            },
            {
              case: { $eq: ['$content.kind', 'image'] },
              then: {
                kind: 'image',
                caption: '$content.media.caption',
                mediaFileName: '$content.media.filename',
              },
            },
            {
              case: { $eq: ['$content.kind', 'document'] },
              then: {
                kind: 'document',
                caption: '$content.media.caption',
                mediaFileName: '$content.media.filename',
              },
            },
            { case: { $eq: ['$content.kind', 'audio'] }, then: { kind: 'audio' } },
            { case: { $eq: ['$content.kind', 'video'] }, then: { kind: 'video' } },
            { case: { $eq: ['$content.kind', 'sticker'] }, then: { kind: 'sticker' } },
          ],
          default: { kind: 'other' },
        },
      },
    },
  };

  const pipeline: Document[] = [
    { $match: { sessionId, to: counterparty } },
    outboundProject,
    {
      $unionWith: {
        coll: 'inbound_messages',
        // why: `counterparty` is the E.164 from the URL; match `fromE164`
        // (set at write-time) rather than the raw JID `from`.
        pipeline: [{ $match: { sessionId, fromE164: counterparty } }, inboundProject],
      },
    },
    {
      $unionWith: {
        coll: 'chat_events',
        pipeline: [
          {
            $match: {
              sessionId,
              direction: { $in: ['out_device', 'out_history', 'in_history'] },
              counterpartyE164: counterparty,
            },
          },
          chatEventProject,
        ],
      },
    },
    { $sort: { ts: -1, _id: -1 } },
  ];

  if (opts.cursor) {
    pipeline.push({
      $match: {
        $or: [
          { ts: { $lt: opts.cursor.ts } },
          { ts: opts.cursor.ts, _cursorId: { $lt: opts.cursor.id } },
        ],
      },
    });
  }

  pipeline.push({ $limit: fetchSize });

  // why: $lookup runs after $limit so each page joins at most `fetchSize`
  // messages against revisions, bounded per-page cost. The lookup matches
  // on either resolved `messageId` (preferred) or `waMessageId` (when the
  // revision arrived before the original message was persisted).
  pipeline.push({
    $lookup: {
      from: 'message_revisions',
      // why: each row's `messageId` field is either a gateway UUID (outbound
      // `messages`), a UUID-ish `inboundId` (inbound), or a raw waMessageId
      // (chat_events `out_device` / `*_history`). Match revisions on either
      // their resolved `messageId` (gateway UUID) or their `waMessageId` so
      // chat_event rows still inline revisions even before resolution.
      let: { rowKey: '$messageId', sId: { $literal: sessionId } },
      pipeline: [
        {
          $match: {
            $expr: {
              $and: [
                { $eq: ['$sessionId', '$$sId'] },
                {
                  $or: [{ $eq: ['$messageId', '$$rowKey'] }, { $eq: ['$waMessageId', '$$rowKey'] }],
                },
              ],
            },
          },
        },
        { $sort: { revisionSeq: 1 } },
        {
          $project: {
            _id: 0,
            revisionSeq: 1,
            kind: 1,
            body: 1,
            deletedBy: 1,
            ts: 1,
          },
        },
      ],
      as: 'revisions',
    },
  });

  // why: bodyPreview self-lookup. Outbound rows carry `replyTo.messageId`
  // (gateway UUID); fetch the original body's text/caption to seed the
  // 280-char preview the UI renders inside the quote chrome. Runs after
  // $limit so per-page cost stays bounded. Inbound and chat_event rows
  // project `replyTo: null` upstream and skip this join via the $expr guard.
  pipeline.push({
    $lookup: {
      from: 'messages',
      let: {
        replyTargetId: '$replyTo.messageId',
        sId: { $literal: sessionId },
      },
      pipeline: [
        {
          $match: {
            $expr: {
              $and: [
                { $ne: ['$$replyTargetId', null] },
                { $eq: ['$messageId', '$$replyTargetId'] },
                { $eq: ['$sessionId', '$$sId'] },
              ],
            },
          },
        },
        {
          $project: {
            _id: 0,
            preview: {
              $switch: {
                branches: [
                  {
                    case: { $eq: ['$body.kind', 'text'] },
                    then: { $ifNull: ['$body.text', ''] },
                  },
                  {
                    case: { $eq: ['$body.kind', 'image'] },
                    then: {
                      $ifNull: ['$body.caption', { $ifNull: ['$body.filename', ''] }],
                    },
                  },
                  {
                    case: { $eq: ['$body.kind', 'document'] },
                    then: {
                      $ifNull: ['$body.caption', { $ifNull: ['$body.filename', ''] }],
                    },
                  },
                ],
                default: '',
              },
            },
          },
        },
        { $limit: 1 },
      ],
      as: 'replyTargetPreview',
    },
  });

  // why: reactions $lookup keyed on (sessionId, waMessageId). Outbound rows
  // identify their target via the gateway UUID `messageId` field, but
  // reactions persist by `waMessageId` (the only id Baileys gives us at
  // capture time). For outbound rows that field is `messageId` (UUID) and
  // for chat_events it's `$waMessageId` already; both reduce to the same
  // raw id we use as the row's `messageId` projection, match on that.
  // Filter out cleared rows (`emoji === ''`) at projection time so the UI
  // never renders empty pills, but keep the underlying audit row in DB.
  pipeline.push({
    $lookup: {
      from: 'message_reactions',
      let: {
        // why: each row carries its underlying WhatsApp id under `waMessageId`
        // (preserved across the union, outbound `messages.waMessageId`,
        // inbound `inbound_messages.waMessageId`, chat_events `waMessageId`).
        // We join on that. Rows without a resolved WA id (outbound that never
        // ack'd) fall through with no reactions, which is correct.
        wamid: '$waMessageId',
        sId: { $literal: sessionId },
      },
      pipeline: [
        {
          $match: {
            $expr: {
              $and: [
                { $ne: ['$$wamid', null] },
                { $eq: ['$sessionId', '$$sId'] },
                { $eq: ['$waMessageId', '$$wamid'] },
                { $ne: ['$emoji', ''] },
              ],
            },
          },
        },
        { $sort: { ts: 1 } },
        {
          $project: {
            _id: 0,
            fromJid: 1,
            fromE164: 1,
            emoji: 1,
            ts: 1,
          },
        },
      ],
      as: 'reactions',
    },
  });

  const c = await col('messages');
  const rows = (await c.aggregate(pipeline).toArray()) as Array<{
    _cursorId: string;
    messageId: string;
    direction: 'in' | 'out';
    ts: Date;
    status?: MessageStatus | null;
    body: AdminThreadMessageDoc['body'];
    revisions?: AdminThreadMessageRevision[];
    replyTo?: {
      messageId?: string | null;
      waMessageId?: string;
      fromMe?: boolean;
    } | null;
    replyTargetPreview?: Array<{ preview?: string }>;
    reactions?: AdminThreadMessageReaction[];
  }>;

  let nextCursor: { ts: Date; id: string } | null = null;
  if (rows.length > limit) {
    const anchor = rows[limit - 1]!;
    nextCursor = { ts: anchor.ts, id: anchor._cursorId };
    rows.length = limit;
  }

  // Dedup by messageId across the union: an outbound DM appears once in
  // `messages` (canonical, with the proper `body.kind`) and once in
  // `chat_events` as `out_device` when Baileys echoes our send. Without this
  // fold the user sees two rows, the real one and a `kind: 'other'` ghost
  // rendered as `[Attachment]`. We keep the row with the more specific
  // `body.kind`; ties resolve to the first occurrence.
  const seen = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const prev = seen.get(r.messageId);
    if (!prev) {
      seen.set(r.messageId, r);
      continue;
    }
    if (prev.body.kind === 'other' && r.body.kind !== 'other') {
      seen.set(r.messageId, r);
    }
  }

  const items: AdminThreadMessageDoc[] = [...seen.values()].map((r) => {
    const revisions = r.revisions ?? [];
    const derived = deriveRevisionState(r.body, revisions);
    const replyTo = projectReplyTo(r.replyTo, r.replyTargetPreview);
    const reactions = (r.reactions ?? []).filter((rx) => rx.emoji !== '');
    return {
      messageId: r.messageId,
      direction: r.direction,
      ts: r.ts,
      body: r.body,
      ...(r.direction === 'out' && r.status ? { status: r.status } : {}),
      _cursorId: r._cursorId,
      ...(revisions.length > 0 ? { revisions } : {}),
      ...(derived.latestBody !== undefined ? { latestBody: derived.latestBody } : {}),
      ...(derived.editedAt ? { editedAt: derived.editedAt } : {}),
      ...(derived.deletedAt ? { deletedAt: derived.deletedAt } : {}),
      ...(replyTo ? { replyTo } : {}),
      ...(reactions.length > 0 ? { reactions } : {}),
    };
  });

  return { items, nextCursor };
}

/**
 * Project the row's stored `replyTo` plus the body preview from the
 * self-`$lookup` into the public-shaped `AdminThreadMessageReplyTo`.
 *
 * Returns undefined when the row has no `replyTo` (inbound rows project null
 * from the union; chat_events also project null). When the original is
 * missing from our store, surfaces the chrome (`messageId` / `waMessageId` /
 * `fromMe`) without `bodyPreview`, the UI can render "Replied to a message"
 * without preview text.
 */
function projectReplyTo(
  stored: { messageId?: string | null; waMessageId?: string; fromMe?: boolean } | null | undefined,
  lookupResult: Array<{ preview?: string }> | undefined,
): AdminThreadMessageReplyTo | undefined {
  if (!stored) return undefined;
  if (!stored.waMessageId) return undefined;
  const preview = lookupResult?.[0]?.preview;
  // why: empty string from the $switch fallback isn't a useful preview;
  // surface only when there's actual content. Truncate at the schema cap so
  // long captions don't exceed the protocol limit.
  const trimmed =
    typeof preview === 'string' && preview.length > 0
      ? preview.length > 280
        ? preview.slice(0, 280)
        : preview
      : undefined;
  return {
    messageId: stored.messageId ?? null,
    waMessageId: stored.waMessageId,
    fromMe: stored.fromMe ?? false,
    ...(trimmed !== undefined ? { bodyPreview: trimmed } : {}),
  };
}

/**
 * Compute `latestBody`, `editedAt`, `deletedAt` from a revisions array.
 * - No revisions → no derived fields; UI falls back to the original body.
 * - Latest revision is `'edit'` → `latestBody` is that revision's body.
 * - Latest revision is `'delete'` → `latestBody` is absent; `deletedAt` set.
 */
function deriveRevisionState(
  originalBody: AdminThreadMessageDoc['body'],
  revisions: AdminThreadMessageRevision[],
): {
  latestBody?: AdminThreadMessageDoc['body'];
  editedAt?: string;
  deletedAt?: string;
} {
  if (revisions.length === 0) return {};
  const latest = revisions[revisions.length - 1]!;
  const lastEdit = [...revisions].reverse().find((r) => r.kind === 'edit');
  const lastDelete = [...revisions].reverse().find((r) => r.kind === 'delete');
  const out: ReturnType<typeof deriveRevisionState> = {};
  if (latest.kind === 'delete') {
    out.deletedAt = latest.ts;
  } else if (latest.kind === 'edit' && latest.body) {
    out.latestBody = latest.body as AdminThreadMessageDoc['body'];
  } else if (lastEdit?.body) {
    out.latestBody = lastEdit.body as AdminThreadMessageDoc['body'];
  }
  if (lastEdit) out.editedAt = lastEdit.ts;
  if (lastDelete && !out.deletedAt) out.deletedAt = lastDelete.ts;
  // why: silence unused-param when the caller doesn't need it; original body
  // is referenced indirectly via the `body` field on the row, kept for
  // signature parity with future enhancements (e.g. delete preserves prior).
  void originalBody;
  return out;
}

/**
 * Stream all messages for a (session, group JID) thread, newest-first.
 *
 * Groups never reach `messages` or `inbound_messages`, outbound device sends
 * land in `chat_events` as `out_device`, and historical outbound/inbound from
 * the phone arrive via Baileys history sync as `out_history` / `in_history`.
 * Live inbound for a group is also persisted as `chat_events` with
 * `direction: 'in'`. So this aggregation reads `chat_events` only, keyed on
 * `counterpartyJid` (groups have `counterpartyE164: null`).
 *
 * Cursor convention mirrors `listThreadMessages`: `(ts, _id)` decoded by the
 * route layer. The repo takes the decoded shape so both functions share the
 * same calling style.
 */
export async function listGroupMessages(
  sessionId: string,
  counterpartyJid: string,
  opts: { cursor?: { ts: Date; id: string } | null; limit?: number } = {},
): Promise<{ items: AdminThreadMessageDoc[]; nextCursor: { ts: Date; id: string } | null }> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
  const fetchSize = limit + 1;

  const groupProject: Document = {
    $project: {
      _id: 1,
      _cursorId: { $toString: '$_id' },
      messageId: '$waMessageId',
      direction: {
        $cond: [{ $in: ['$direction', ['in', 'in_history']] }, 'in', 'out'],
      },
      ts: '$ts',
      status: { $literal: null },
      body: {
        $switch: {
          branches: [
            {
              case: { $eq: ['$content.kind', 'text'] },
              then: { kind: 'text', text: { $ifNull: ['$content.text', ''] } },
            },
            {
              case: { $eq: ['$content.kind', 'image'] },
              then: {
                kind: 'image',
                caption: '$content.media.caption',
                mediaFileName: '$content.media.filename',
              },
            },
            {
              case: { $eq: ['$content.kind', 'document'] },
              then: {
                kind: 'document',
                caption: '$content.media.caption',
                mediaFileName: '$content.media.filename',
              },
            },
            { case: { $eq: ['$content.kind', 'audio'] }, then: { kind: 'audio' } },
            { case: { $eq: ['$content.kind', 'video'] }, then: { kind: 'video' } },
            { case: { $eq: ['$content.kind', 'sticker'] }, then: { kind: 'sticker' } },
          ],
          default: { kind: 'other' },
        },
      },
    },
  };

  const pipeline: Document[] = [
    {
      $match: {
        sessionId,
        counterpartyJid,
        counterpartyE164: null,
        direction: { $in: ['in', 'out_device', 'in_history', 'out_history'] },
      },
    },
    groupProject,
    { $sort: { ts: -1, _id: -1 } },
  ];

  if (opts.cursor) {
    pipeline.push({
      $match: {
        $or: [
          { ts: { $lt: opts.cursor.ts } },
          { ts: opts.cursor.ts, _cursorId: { $lt: opts.cursor.id } },
        ],
      },
    });
  }

  pipeline.push({ $limit: fetchSize });

  const c = await chatEvents();
  const rows = (await c.aggregate(pipeline).toArray()) as Array<{
    _cursorId: string;
    messageId: string;
    direction: 'in' | 'out';
    ts: Date;
    status?: MessageStatus | null;
    body: AdminThreadMessageDoc['body'];
  }>;

  let nextCursor: { ts: Date; id: string } | null = null;
  if (rows.length > limit) {
    const anchor = rows[limit - 1]!;
    nextCursor = { ts: anchor.ts, id: anchor._cursorId };
    rows.length = limit;
  }

  const items: AdminThreadMessageDoc[] = rows.map((r) => ({
    messageId: r.messageId,
    direction: r.direction,
    ts: r.ts,
    body: r.body,
    _cursorId: r._cursorId,
  }));

  return { items, nextCursor };
}

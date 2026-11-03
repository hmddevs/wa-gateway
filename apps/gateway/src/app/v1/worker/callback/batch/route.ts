/**
 * POST /v1/worker/callback/batch
 *
 * Bulk worker → gateway ingress for pre-pair history sync. Accepts either a
 * `chat_event_batch` (Baileys `messaging-history.set` replay) or a
 * `contact_batch` (Baileys `contacts.set` snapshot). Single envelope is
 * HMAC-signed; nonces dedup over 10 min; timestamps are ±60s fresh.
 *
 * why: this endpoint MUST NOT trigger webhook fan-out, opt-out keyword
 * detection, auto-read receipts, or admin notifications. History rows are
 * historical by definition, replaying them as fresh notifications would
 * spam every webhook subscriber with potentially years-old messages. Storage
 * only. The single-event `chat_event` branch in `route.ts` enforces the same
 * invariant per-event; this batch endpoint is the bulk equivalent.
 */
import 'server-only';
import { z } from 'zod';
import {
  ErrorCodes,
  SessionIdSchema,
  ChatEventBatchItemSchema,
  ContactBatchItemSchema,
  GroupMetadataEventBatchItemSchema,
  HistorySyncBatchHeaderSchema,
  type ChatEventDoc,
  type GroupDoc,
} from '@hmddevs/protocol';
import { errorResponse, jsonResponse } from '@/lib/http';
import { mintRequestId } from '@/lib/request-id';
import { verifyWorkerJwt } from '@/lib/worker-jwt';
import { assertWorkerGenerationFresh, RevokedTokenError } from '@/lib/worker-auth';
import { verify as verifyWire, acceptNonce, isFreshTimestamp } from '@/lib/wire';
import { insertChatEventBatch } from '@/lib/repositories/chat-events';
import { bulkUpsertChatContacts } from '@/lib/repositories/chat-contacts';
import { upsertGroupBatch } from '@/lib/repositories/groups';
import { updateSession, invalidateSessionCache } from '@/lib/repositories/sessions';
import { checkHistorySyncBatch } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const EnvelopeBase = z.object({
  v: z.literal(1),
  nonce: z.string().min(16),
  at: z.string().min(10),
  sig: z.string().min(16),
});

// why: the wire uses a `kind`-keyed envelope (set by the worker's
// `gateway-client.batchCallback`); the protocol-level item schemas
// (`ChatEventBatchItemSchema`, `ContactBatchItemSchema`) are the single
// source of truth for the inner shape. Keeping the wrapper local avoids the
// `type` vs `kind` drift the previous duplicated definitions had.
const ChatEventBatch = EnvelopeBase.extend({
  kind: z.literal('chat_event_batch'),
  workerId: z.string().min(1),
  sessionId: SessionIdSchema,
  events: z.array(ChatEventBatchItemSchema).max(500),
  isLatest: z.boolean(),
  // why: present on history-sync envelopes only (slice 3). Optional so live
  // batches and the existing test fixtures continue to parse without it.
  historySync: HistorySyncBatchHeaderSchema.optional(),
});

const ContactBatch = EnvelopeBase.extend({
  kind: z.literal('contact_batch'),
  workerId: z.string().min(1),
  sessionId: SessionIdSchema,
  contacts: z.array(ContactBatchItemSchema).max(500),
});

const GroupMetadataBatch = EnvelopeBase.extend({
  kind: z.literal('group_metadata_batch'),
  workerId: z.string().min(1),
  sessionId: SessionIdSchema,
  items: z.array(GroupMetadataEventBatchItemSchema).max(1000),
});

const AnyBatchEnvelope = z.discriminatedUnion('kind', [
  ChatEventBatch,
  ContactBatch,
  GroupMetadataBatch,
]);

export async function POST(req: Request): Promise<Response> {
  const requestId = mintRequestId(req.headers.get('x-request-id'));
  const authz = req.headers.get('authorization');
  if (!authz?.startsWith('Bearer ')) {
    return errorResponse(401, ErrorCodes.UNAUTHORIZED, 'Missing worker token', requestId);
  }
  let claims;
  try {
    claims = await verifyWorkerJwt(authz.slice(7).trim());
  } catch {
    return errorResponse(401, ErrorCodes.UNAUTHORIZED, 'Invalid worker token', requestId);
  }
  // Bootstrap tokens are single-use refresh credentials only; they must never
  // authorise a wire operation (mirrors the callback route).
  if (claims.typ === 'bootstrap') {
    return errorResponse(401, ErrorCodes.UNAUTHORIZED, 'Bootstrap token not accepted', requestId);
  }
  // Reject a superseded (revoked/rotated) refresh token; fail open on infra error.
  try {
    await assertWorkerGenerationFresh(claims);
  } catch (err: unknown) {
    if (err instanceof RevokedTokenError) {
      logger.warn(
        { workerId: claims.workerId, requestId },
        'worker batch callback rejected: token revoked (stale generation)',
      );
      return errorResponse(401, ErrorCodes.UNAUTHORIZED, 'Worker token revoked', requestId);
    }
    logger.warn(
      { err: (err as Error).message, workerId: claims.workerId, requestId },
      'worker generation check failed; failing open',
    );
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return errorResponse(400, ErrorCodes.INVALID_BODY, 'Invalid JSON', requestId);
  }

  const parsed = AnyBatchEnvelope.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(400, ErrorCodes.INVALID_BODY, parsed.error.message, requestId);
  }
  const env_ = parsed.data;

  if (!isFreshTimestamp(env_.at)) {
    return errorResponse(400, ErrorCodes.INVALID_BODY, 'Stale timestamp', requestId);
  }
  const sigOk = await verifyWire(env_ as unknown as { sig: string });
  if (!sigOk) {
    return errorResponse(401, ErrorCodes.UNAUTHORIZED, 'Invalid signature', requestId);
  }
  if (!(await acceptNonce(env_.nonce))) {
    return errorResponse(409, ErrorCodes.IDEMPOTENCY_CONFLICT, 'Replay detected', requestId);
  }

  if (env_.kind === 'chat_event_batch') {
    // why: history-sync batches carry a `historySync` envelope marker. When
    // present, charge the per-session sliding-window bucket (5,000 events /
    // minute / session). Live `out_device` batches are unmetered as before, // they're at most a few events at a time and the existing global
    // throttle on the worker side bounds them. A 429 here is a soft signal:
    // the worker pauses and resumes once the bucket clears.
    if (env_.historySync) {
      const ok = await checkHistorySyncBatch(env_.sessionId, env_.events.length);
      if (!ok) {
        logger.warn(
          {
            sessionId: env_.sessionId,
            workerId: env_.workerId,
            batchSize: env_.events.length,
            batchIndex: env_.historySync.batchIndex,
          },
          'history-sync batch rate-limited',
        );
        return errorResponse(
          429,
          ErrorCodes.RATE_LIMITED,
          'History sync rate limit exceeded',
          requestId,
        );
      }
    }
    const ingestedAt = new Date();
    const docs: ChatEventDoc[] = env_.events.map((e) => ({
      sessionId: env_.sessionId,
      workerId: env_.workerId,
      waMessageId: e.waMessageId,
      direction: e.direction,
      source: e.source,
      counterpartyJid: e.counterpartyJid,
      counterpartyE164: e.counterpartyE164,
      content: e.content,
      ts: new Date(e.ts),
      ingestedAt,
    }));

    let inserted = 0;
    let duplicates = 0;
    try {
      const r = await insertChatEventBatch(docs);
      inserted = r.inserted;
      duplicates = r.duplicates;
    } catch (err: unknown) {
      logger.error(
        {
          err: (err as Error).message,
          sessionId: env_.sessionId,
          workerId: env_.workerId,
          batchSize: docs.length,
        },
        'chat_event_batch persist failed',
      );
      return errorResponse(500, ErrorCodes.INTERNAL, 'Batch persist failed', requestId);
    }

    // why: do NOT call dispatchEventBackground / mapInboundForWebhook /
    // listKeysBySession / addOptOut / readMessages here. History rows are
    // historical and out_* events are our own outbound, neither should
    // trigger fresh notifications, opt-out detection, or read receipts.
    logger.info(
      {
        sessionId: env_.sessionId,
        workerId: env_.workerId,
        batchSize: docs.length,
        inserted,
        duplicates,
        isLatest: env_.isLatest,
      },
      'chat_event_batch ingested',
    );

    // why: clear the HistorySyncBadge as soon as the final batch lands, // don't wait for the next heartbeat window. The heartbeat also zeroes
    // the field, but if the terminator batch fails on the worker side the
    // heartbeat path is never reached and the badge stays amber forever.
    if (env_.isLatest) {
      updateSession(env_.sessionId, { historySyncProgress: null }).catch((err: unknown) => {
        logger.warn(
          { err: (err as Error).message, sessionId: env_.sessionId },
          'historySyncProgress clear failed, badge will clear on next heartbeat',
        );
      });
      // Invalidate cache after Mongo write (fire-and-forget).
      invalidateSessionCache(env_.sessionId).catch(() => {});
    }

    return jsonResponse(200, { ok: true, inserted, duplicates }, requestId);
  }

  if (env_.kind === 'contact_batch') {
    let upserted = 0;
    let modified = 0;
    try {
      const r = await bulkUpsertChatContacts(env_.sessionId, env_.contacts);
      upserted = r.upserted;
      modified = r.modified;
    } catch (err: unknown) {
      logger.error(
        {
          err: (err as Error).message,
          sessionId: env_.sessionId,
          workerId: env_.workerId,
          batchSize: env_.contacts.length,
        },
        'contact_batch persist failed',
      );
      return errorResponse(500, ErrorCodes.INTERNAL, 'Contact batch persist failed', requestId);
    }
    // why: contacts are reference data; never fan out to webhooks.
    logger.info(
      {
        sessionId: env_.sessionId,
        workerId: env_.workerId,
        upserted,
        modified,
        total: env_.contacts.length,
      },
      'contact_batch ingested',
    );
    return jsonResponse(200, { ok: true, upserted, modified }, requestId);
  }

  if (env_.kind === 'group_metadata_batch') {
    // why: replace-on-conflict per `(sessionId, jid)`, same semantics as the
    // single `group_metadata` event in `route.ts`. Reference data, never
    // fans out to webhooks. Never log participant JIDs, subjects,
    // descriptions, or invite codes; jid + participant count only.
    const fetchedAt = new Date().toISOString();
    const docs: GroupDoc[] = env_.items.map((item) => ({
      ...item.metadata,
      sessionId: env_.sessionId,
      fetchedAt,
    }));

    try {
      await upsertGroupBatch(docs);
    } catch (err: unknown) {
      logger.error(
        {
          err: (err as Error).message,
          sessionId: env_.sessionId,
          workerId: env_.workerId,
          batchSize: docs.length,
        },
        'group_metadata_batch persist failed',
      );
      return errorResponse(500, ErrorCodes.INTERNAL, 'Batch persist failed', requestId);
    }

    logger.info(
      {
        sessionId: env_.sessionId,
        workerId: env_.workerId,
        batchSize: docs.length,
      },
      'group_metadata_batch ingested',
    );
    return jsonResponse(200, { ok: true, upserted: docs.length }, requestId);
  }

  return errorResponse(400, ErrorCodes.INVALID_BODY, 'Unhandled batch kind', requestId);
}

/**
 * POST /v1/worker/callback
 *
 * Single worker → gateway ingress for all asynchronous events:
 * heartbeat, pairing status, send-ack, delivery-receipt, inbound message.
 *
 * Authentication is BOTH:
 *   - Worker JWT (Authorization: Bearer ...)
 *   - HMAC-signed envelope (sig, nonce, at)
 *
 * Nonces live 10 min. Every kind except `heartbeat` dedups via Redis (SET NX
 * EX). `heartbeat`, the highest-volume kind, dedups via an in-process Map
 * instead (single-instance assumption; see the comment on
 * `acceptHeartbeatNonce` in `@/lib/wire`). Timestamps must be within ±60s for
 * every kind.
 */
import 'server-only';
import { z } from 'zod';
import { ErrorCodes } from '@hmddevs/protocol';
import { errorResponse, jsonResponse } from '@/lib/http';
import { mintRequestId } from '@/lib/request-id';
import { verifyWorkerJwt } from '@/lib/worker-jwt';
import {
  verify as verifyWire,
  acceptNonce,
  acceptHeartbeatNonce,
  acceptInboundOnce,
  acceptOnce,
  isFreshTimestamp,
} from '@/lib/wire';
import { upsertWorker } from '@/lib/repositories/worker-state';
import { assertWorkerGenerationFresh, RevokedTokenError } from '@/lib/worker-auth';
import {
  updateSession,
  getSession,
  invalidateSessionCache,
  markWarmupStarted,
} from '@/lib/repositories/sessions';
import { addOptOut, isOptedOut } from '@/lib/repositories/optouts';
import { getOrgForSession, isOptedOutAcrossOrg } from '@/lib/repositories/organizations';
import { penaliseSession, rewardSession } from '@/lib/session-state';
import { tryStartPendingOptOut, clearPendingOptOut } from '@/lib/repositories/optout-pending';
import { getRedis } from '@/lib/redis';
import { channels, sign, newNonce, nowIso, lpushPending } from '@/lib/wire';
import { updateStatus, findByMessageId, findByWaMessageId } from '@/lib/repositories/messages';
import { appendAudit } from '@/lib/repositories/audit';
import { listKeysBySession } from '@/lib/repositories/api-keys';
import { insertInbound } from '@/lib/repositories/inbound-messages';
import { insertChatEvent } from '@/lib/repositories/chat-events';
import {
  ChatEventDirectionSchema,
  ChatEventSourceSchema,
  ChatEventContentSchema,
  E164Schema,
  MessageRevisionBodySchema,
  MessageRevisionDeletedBySchema,
  MessageRevisionSourceSchema,
  MessageRevisionKindSchema,
  ContactSourceSchema,
  SessionIdSchema,
  GroupMetadataSchema,
  type MessageRevisionEvent,
  type ContactEvent,
  type GroupDoc,
} from '@hmddevs/protocol';
import { insertRevisionFromEvent } from '@/lib/repositories/message-revisions';
import { upsertContactFromEvent } from '@/lib/repositories/contacts';
import { upsertReactionFromEvent } from '@/lib/repositories/message-reactions';
import { upsertGroup } from '@/lib/repositories/groups';
import { dispatchEventBackground } from '@/lib/webhook-dispatch';
import { publishAdminStream } from '@/lib/admin-stream';
import { jidToE164 } from '@/lib/phone';
import { logger } from '@/lib/logger';
import { createHash, randomUUID } from 'node:crypto';
import type { WebhookEvent } from '@hmddevs/protocol';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const EnvelopeBase = z.object({
  v: z.literal(1),
  nonce: z.string().min(16),
  at: z.string().min(10),
  sig: z.string().min(16),
});

const Heartbeat = EnvelopeBase.extend({
  kind: z.literal('heartbeat'),
  workerId: z.string().min(1),
  sessionId: z.string().min(1),
  status: z.enum(['pairing', 'connected', 'degraded', 'offline']),
  phoneE164: z.string().nullable().optional(),
  /** Outbound Redis subscription is live (connected AND listening). Optional
   *  for an older worker that predates the field. */
  subscribed: z.boolean().optional(),
  deviceName: z.string().nullable().optional(),
  version: z.string().nullable().optional(),
  hostname: z.string().nullable().optional(),
  publicIp: z.string().nullable().optional(),
  queueDepth: z.number().int().nonnegative().optional(),
  /** PR-2: pre-pair history-sync progress badge; null/absent → no sync. */
  historySyncProgress: z
    .object({
      received: z.number().int().nonnegative(),
      isLatest: z.boolean(),
    })
    .nullable()
    .optional(),
});

const Pairing = EnvelopeBase.extend({
  kind: z.literal('pairing'),
  workerId: z.string().min(1),
  sessionId: z.string().min(1),
  event: z.enum(['qr', 'paired', 'logged_out']),
  qr: z.string().optional(), // data URL or base64 string; stored in worker_state.pairing
});

const SendAck = EnvelopeBase.extend({
  kind: z.literal('send_ack'),
  messageId: z.string().min(1),
  waMessageId: z.string().optional(),
  ok: z.boolean(),
  code: z.string().optional(),
  detail: z.string().optional(),
});

const Receipt = EnvelopeBase.extend({
  kind: z.literal('receipt'),
  // `messages.update` only exposes the WhatsApp message id, so modern workers
  // resolve the gateway message via (sessionId, waMessageId). `messageId` (the
  // gateway UUID) stays optional for legacy callers; the handler requires at
  // least one resolvable key.
  messageId: z.string().min(1).optional(),
  status: z.enum(['sent', 'delivered', 'read', 'failed']),
  waMessageId: z.string().optional(),
  sessionId: z.string().min(1).optional(),
  code: z.string().optional(),
  detail: z.string().optional(),
});

const Inbound = EnvelopeBase.extend({
  kind: z.literal('inbound'),
  workerId: z.string().min(1),
  /** Optional for backwards-compat with older workers; required for webhook dispatch. */
  sessionId: z.string().min(1).optional(),
  waMessageId: z.string().min(1),
  from: z.string().min(6),
  body: z.object({
    kind: z.enum(['text', 'image', 'document', 'audio', 'video', 'sticker', 'other']),
    text: z.string().optional(),
    mediaUrl: z.string().url().optional(),
    mediaMimeType: z.string().optional(),
    mediaFileName: z.string().optional(),
    caption: z.string().optional(),
  }),
  at: z.string(),
});

const Reaction = EnvelopeBase.extend({
  kind: z.literal('reaction'),
  workerId: z.string().min(1),
  sessionId: z.string().min(1),
  targetWaMessageId: z.string().min(1),
  targetFromMe: z.boolean(),
  from: z.string().min(6),
  fromJid: z.string().min(1),
  emoji: z.string(),
});

const ChatEvent = EnvelopeBase.extend({
  kind: z.literal('chat_event'),
  workerId: z.string().min(1),
  sessionId: z.string().min(1),
  waMessageId: z.string().min(1),
  direction: ChatEventDirectionSchema,
  source: ChatEventSourceSchema,
  counterpartyJid: z.string().min(1),
  counterpartyE164: E164Schema.nullable(),
  content: ChatEventContentSchema,
  ts: z.string().datetime({ offset: true }),
});

// why: route-local schema for `kind: 'message_revision'`. The protocol's
// `MessageRevisionEventSchema` defines the shape with `type` discriminator
// and inner `kind: 'edit' | 'delete'`. The route envelope uses `kind` for
// its outer discriminator, so the inner field is renamed to `revisionKind`
// to avoid the collision. The route flattens this back to the protocol
// `kind` shape before calling the repo.
// why: zod's `discriminatedUnion` rejects ZodEffects members, so the
// edit/delete refinement is enforced inside the case handler instead of via
// `superRefine`. Schema below stays a plain ZodObject.
const MessageRevision = EnvelopeBase.extend({
  kind: z.literal('message_revision'),
  workerId: z.string().min(1),
  sessionId: SessionIdSchema,
  waMessageId: z.string().min(1),
  revisionKind: MessageRevisionKindSchema,
  body: MessageRevisionBodySchema.optional(),
  deletedBy: MessageRevisionDeletedBySchema.optional(),
  ts: z.string().datetime({ offset: true }),
  source: MessageRevisionSourceSchema,
});

const Contact = EnvelopeBase.extend({
  kind: z.literal('contact'),
  workerId: z.string().min(1),
  sessionId: SessionIdSchema,
  e164: E164Schema,
  waJid: z.string().min(1),
  displayName: z.string().min(1).max(200).optional(),
  pushName: z.string().min(1).max(200).optional(),
  profilePictureUrl: z.string().url().optional(),
  isBusiness: z.boolean(),
  lastSeenAt: z.string().datetime({ offset: true }).optional(),
  source: ContactSourceSchema,
});

const GroupMetadata = EnvelopeBase.extend({
  kind: z.literal('group_metadata'),
  workerId: z.string().min(1),
  sessionId: SessionIdSchema,
  metadata: GroupMetadataSchema,
});

const AnyEnvelope = z.discriminatedUnion('kind', [
  Heartbeat,
  Pairing,
  SendAck,
  Receipt,
  Inbound,
  Reaction,
  ChatEvent,
  MessageRevision,
  Contact,
  GroupMetadata,
]);

/**
 * Best-effort outbound text send used by the opt-out handshake (confirmation
 * prompt and unsubscribe acknowledgement). Mirrors the publish path in
 * /v1/messages: sign a `send` wire envelope, push it to the per-session pending
 * list, and publish on the outbound channel so a live worker consumes it now.
 *
 * Fire-and-forget: any failure is logged as a warning and swallowed. The
 * callback must still return success for the inbound message even if the
 * handshake reply cannot be delivered.
 */
async function sendHandshakeText(sessionId: string, to: string, text: string): Promise<void> {
  try {
    const envelope = await sign({
      v: 1,
      kind: 'send' as const,
      messageId: randomUUID(),
      to,
      body: { kind: 'text' as const, text },
      channel: 'transactional' as const,
      requestId: mintRequestId(null),
      nonce: newNonce(),
      at: nowIso(),
      sig: '',
    });
    const wire = JSON.stringify(envelope);
    const redis = getRedis();
    await Promise.all([
      lpushPending(sessionId, wire),
      redis.publish(channels.outbound(sessionId), wire),
    ]);
  } catch (err: unknown) {
    logger.warn(
      { err: (err as Error).message, sessionId },
      'opt-out handshake reply send failed (best-effort)',
    );
  }
}

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

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return errorResponse(400, ErrorCodes.INVALID_BODY, 'Invalid JSON', requestId);
  }

  const parsed = AnyEnvelope.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(400, ErrorCodes.INVALID_BODY, parsed.error.message, requestId);
  }
  const env_ = parsed.data;

  if (!isFreshTimestamp(env_.at)) {
    return errorResponse(400, ErrorCodes.INVALID_BODY, 'Stale timestamp', requestId);
  }
  const sigOk = await verifyWire(env_ as any);
  if (!sigOk) {
    return errorResponse(401, ErrorCodes.UNAUTHORIZED, 'Invalid signature', requestId);
  }
  // `kind` is already known from the discriminated-union parse above, so the
  // nonce dedup can branch on it directly. Only `heartbeat`, the
  // highest-volume kind, uses the in-process store; every other kind keeps
  // the Redis-backed path unchanged (see @/lib/wire for the rationale).
  const nonceAccepted =
    env_.kind === 'heartbeat' ? acceptHeartbeatNonce(env_.nonce) : await acceptNonce(env_.nonce);
  if (!nonceAccepted) {
    return errorResponse(409, ErrorCodes.IDEMPOTENCY_CONFLICT, 'Replay detected', requestId);
  }

  // ── W2.2: token type + generation binding ────────────────────────────────
  // A valid signature on the JWT proves "some authenticated worker", not "a
  // worker authorised to act right now". Two extra checks close that gap and
  // mirror the semantics already enforced by /v1/worker/refresh:
  //   - bootstrap tokens are single-use refresh credentials only; they must
  //     never authorise a callback write.
  //   - a refresh token whose generation is older than the worker's current
  //     `tokenGen` is a superseded (possibly leaked) credential; reject it so
  //     rotation actually revokes callback access rather than leaving a 30-day
  //     window open.
  if (claims.typ === 'bootstrap') {
    logger.warn(
      { workerId: claims.workerId, kind: env_.kind, requestId },
      'worker callback rejected: bootstrap token presented (refresh-only)',
    );
    return errorResponse(401, ErrorCodes.UNAUTHORIZED, 'Bootstrap token not accepted', requestId);
  }
  // Strict `gen < tokenGen` revocation check via the shared cached helper. A
  // RevokedTokenError is a deliberate kill (rotation / admin revoke) → 401. Any
  // other error (DB/Redis blip) must FAIL OPEN so infra never takes the live
  // workers offline.
  try {
    await assertWorkerGenerationFresh(claims);
  } catch (err: unknown) {
    if (err instanceof RevokedTokenError) {
      logger.warn(
        { workerId: claims.workerId, kind: env_.kind, requestId },
        'worker callback rejected: token revoked (stale generation)',
      );
      return errorResponse(401, ErrorCodes.UNAUTHORIZED, 'Worker token revoked', requestId);
    }
    logger.warn(
      { err: (err as Error).message, workerId: claims.workerId, requestId },
      'worker generation check failed; failing open',
    );
  }

  // ── W2.1: bind the verified JWT identity to the envelope ──────────────────
  // The HMAC envelope is signed with a single shared WORKER_WIRE_SECRET, so a
  // valid signature proves "a worker", not "this worker". The JWT `sub`
  // (claims.workerId) is the only per-worker identity on the request. Every
  // envelope that names a workerId must match it, and every envelope that
  // targets a session must target a session owned by that worker. send_ack and
  // receipt carry neither field (they key on an unguessable gateway-minted
  // messageId), so they fall through to their existing message-scoped logic.
  const envelopeWorkerId = 'workerId' in env_ ? env_.workerId : undefined;
  if (envelopeWorkerId !== undefined && envelopeWorkerId !== claims.workerId) {
    logger.warn(
      {
        tokenWorkerId: claims.workerId,
        envelopeWorkerId,
        kind: env_.kind,
        requestId,
      },
      'worker callback rejected: envelope workerId does not match token',
    );
    return errorResponse(403, ErrorCodes.UNAUTHORIZED, 'Worker identity mismatch', requestId);
  }
  const envelopeSessionId =
    'sessionId' in env_ && typeof env_.sessionId === 'string' ? env_.sessionId : undefined;
  if (envelopeSessionId !== undefined) {
    // Sessions are created with a workerId already bound (admin UI / WORKER_ID
    // default), so there is no genuinely ownerless state. A missing session doc
    // is allowed through: updateSession is a no-op for absent sessions, so no
    // cross-worker write can occur, and blocking would break the legitimate
    // race where a callback lands before the session row is visible. When the
    // session exists, its owner must match the authenticated worker.
    const sessionDoc = await getSession(envelopeSessionId);
    if (sessionDoc && sessionDoc.workerId !== claims.workerId) {
      logger.warn(
        {
          tokenWorkerId: claims.workerId,
          sessionOwnerWorkerId: sessionDoc.workerId,
          sessionId: envelopeSessionId,
          kind: env_.kind,
          requestId,
        },
        'worker callback rejected: session owned by a different worker',
      );
      return errorResponse(403, ErrorCodes.UNAUTHORIZED, 'Session ownership mismatch', requestId);
    }
  }

  switch (env_.kind) {
    case 'heartbeat': {
      const heartbeatAt = new Date();
      await upsertWorker(env_.workerId, {
        status: env_.status,
        lastHeartbeatAt: heartbeatAt,
        phoneE164: env_.phoneE164 ?? undefined,
        deviceName: env_.deviceName ?? undefined,
        version: env_.version ?? undefined,
        hostname: env_.hostname ?? undefined,
        publicIp: env_.publicIp ?? undefined,
        queueDepth: env_.queueDepth,
      });
      await updateSession(env_.sessionId, {
        workerId: env_.workerId,
        status: env_.status,
        lastHeartbeatAt: heartbeatAt,
        phoneE164: env_.phoneE164 ?? null,
        version: env_.version ?? null,
        historySyncProgress: env_.historySyncProgress ?? null,
        // Persist outbound-subscription health when the worker reports it.
        // Absent (older worker) leaves the stored value untouched.
        ...(env_.subscribed !== undefined ? { subscribed: env_.subscribed } : {}),
      });
      // Invalidate cache after Mongo write (fire-and-forget).
      invalidateSessionCache(env_.sessionId).catch(() => {});
      // why: a worker can be WhatsApp-connected yet deaf to outbound sends if
      // its Redis SUBSCRIBE silently died (half-open). Surface that mismatch
      // loudly, it is the exact failure mode that previously went undetected.
      if (env_.subscribed === false && env_.status === 'connected') {
        logger.warn(
          { workerId: env_.workerId, sessionId: env_.sessionId },
          'worker connected but outbound subscription down',
        );
      }
      break;
    }
    case 'pairing': {
      const pairingStatus =
        env_.event === 'paired' ? 'connected' : env_.event === 'logged_out' ? 'offline' : 'pairing';
      const pairingAt = new Date();
      await upsertWorker(env_.workerId, {
        status: pairingStatus,
        connectedAt: env_.event === 'paired' ? pairingAt : undefined,
        ...({ pairing: { event: env_.event, qr: env_.qr, at: pairingAt } } as any),
      });
      await updateSession(env_.sessionId, {
        workerId: env_.workerId,
        status: pairingStatus,
        pairing: { event: env_.event, qr: env_.qr, at: pairingAt },
        connectedAt: env_.event === 'paired' ? pairingAt : undefined,
      });
      // A number's warm-up ramp starts the first time it pairs, not when its
      // session row was created, an unscanned QR is not a live number.
      if (env_.event === 'paired') {
        await markWarmupStarted(env_.sessionId, pairingAt).catch((err: Error) =>
          logger.warn({ err: err.message, sessionId: env_.sessionId }, 'warm-up stamp failed'),
        );
      }
      // Invalidate cache after Mongo write (fire-and-forget).
      invalidateSessionCache(env_.sessionId).catch(() => {});
      await appendAudit({
        actor: { kind: 'system', id: 'worker' },
        action: `worker.pairing.${env_.event}`,
        target: { kind: 'worker', id: env_.workerId },
      }).catch(() => {});
      break;
    }
    case 'send_ack': {
      const at = new Date();
      const newStatus: 'sent' | 'failed' = env_.ok ? 'sent' : 'failed';
      await updateStatus(
        env_.messageId,
        {
          status: newStatus,
          at,
          code: env_.code,
          detail: env_.detail,
        },
        {
          waMessageId: env_.waMessageId ?? null,
          errorCode: env_.ok ? undefined : env_.code,
          errorDetail: env_.ok ? undefined : env_.detail,
        },
      );
      // Resolve scope (apiKeyId, sessionId) from the message and dispatch.
      const msg = await findByMessageId(env_.messageId);
      if (msg) {
        // Health feedback loop. This is the signal the old pool picker had no
        // way to see: WhatsApp throttles a number while its socket stays open
        // and heartbeating, so the only evidence is sends starting to fail.
        // Repeated failures take the number below the router's eligibility
        // floor and it stops being offered work until it recovers.
        // Best-effort, a Redis blip must never fail the worker's callback.
        void (env_.ok ? rewardSession(msg.sessionId) : penaliseSession(msg.sessionId)).catch(
          (err: Error) =>
            logger.warn(
              { err: err.message, sessionId: msg.sessionId },
              'session health update failed',
            ),
        );
        // Admin SSE, narrow status to the live-stream union (drops 'expired'
        // and 'scheduled' which are gateway-internal lifecycle states the UI
        // doesn't surface live).
        await publishAdminStream({
          kind: 'message_status',
          sessionId: msg.sessionId,
          messageId: msg.messageId,
          status: newStatus,
        });
        if (env_.ok && env_.waMessageId) {
          const event: WebhookEvent = {
            type: 'message.sent',
            at: at.toISOString(),
            eventId: randomUUID(),
            sessionId: msg.sessionId,
            messageId: msg.messageId,
            waMessageId: env_.waMessageId,
          };
          dispatchEventBackground(event, { apiKeyId: msg.apiKeyId, sessionId: msg.sessionId });
        } else if (!env_.ok) {
          const event: WebhookEvent = {
            type: 'message.failed',
            at: at.toISOString(),
            eventId: randomUUID(),
            sessionId: msg.sessionId,
            messageId: msg.messageId,
            status: 'failed',
            error: {
              code: env_.code ?? 'UNKNOWN',
              message: env_.detail ?? 'send failed',
              retryable: false,
            },
          };
          dispatchEventBackground(event, { apiKeyId: msg.apiKeyId, sessionId: msg.sessionId });
        }
      } else {
        logger.warn(
          { messageId: env_.messageId },
          'send_ack for unknown message; skipping webhook dispatch',
        );
      }
      break;
    }
    case 'receipt': {
      const at = new Date();
      // Resolve the gateway message. `messages.update` only exposes the WhatsApp
      // id, so modern workers send (waMessageId, sessionId); legacy callers may
      // still send the gateway messageId. Try the precise id first, then fall
      // back to the pool-normalised (sessionId, waMessageId). Resolving FIRST
      // (vs the old blind updateStatus on a possibly-WhatsApp id) is what makes
      // delivered/read receipts actually advance status and fire webhooks.
      let msg = env_.messageId ? await findByMessageId(env_.messageId) : null;
      if (!msg && env_.waMessageId && env_.sessionId) {
        const { sessionId: ds } = await resolveDispatch(env_.sessionId);
        msg = await findByWaMessageId(ds, env_.waMessageId);
      }
      if (!msg) {
        logger.warn(
          { messageId: env_.messageId, waMessageId: env_.waMessageId },
          'receipt for unknown message; skipping webhook dispatch',
        );
        break;
      }
      await updateStatus(msg.messageId, {
        status: env_.status,
        at,
        code: env_.code,
        detail: env_.detail,
      });
      // Cross-device dedup of the customer-facing webhook: both linked devices
      // (primary + backup) receive the same status update and both report it. updateStatus
      // above is idempotent; gate only the webhook + SSE on a sessionId-agnostic
      // key so a paying customer gets one message.delivered/read, not two. Fail
      // OPEN on a Redis error so a real receipt webhook is never dropped.
      let firstReport = true;
      try {
        firstReport = await acceptOnce(`receipt:${msg.messageId}:${env_.status}`);
      } catch {
        firstReport = true;
      }
      if (!firstReport) {
        logger.debug(
          { messageId: msg.messageId, status: env_.status },
          'duplicate receipt (second linked device); skipping webhook + SSE',
        );
        break;
      }
      // Admin SSE, receipt status is already in the live-stream union.
      await publishAdminStream({
        kind: 'message_status',
        sessionId: msg.sessionId,
        messageId: msg.messageId,
        status: env_.status,
      });
      if (env_.status === 'delivered' || env_.status === 'read') {
        const waId = env_.waMessageId ?? msg.waMessageId ?? null;
        if (!waId) {
          logger.warn(
            { messageId: env_.messageId, status: env_.status },
            'receipt missing waMessageId; skipping webhook dispatch',
          );
          break;
        }
        const event: WebhookEvent =
          env_.status === 'delivered'
            ? {
                type: 'message.delivered',
                at: at.toISOString(),
                eventId: randomUUID(),
                sessionId: msg.sessionId,
                messageId: msg.messageId,
                waMessageId: waId,
              }
            : {
                type: 'message.read',
                at: at.toISOString(),
                eventId: randomUUID(),
                sessionId: msg.sessionId,
                messageId: msg.messageId,
                waMessageId: waId,
              };
        dispatchEventBackground(event, { apiKeyId: msg.apiKeyId, sessionId: msg.sessionId });
      } else if (env_.status === 'failed') {
        const event: WebhookEvent = {
          type: 'message.failed',
          at: at.toISOString(),
          eventId: randomUUID(),
          sessionId: msg.sessionId,
          messageId: msg.messageId,
          status: 'failed',
          error: {
            code: env_.code ?? 'UNKNOWN',
            message: env_.detail ?? 'failed',
            retryable: false,
          },
        };
        dispatchEventBackground(event, { apiKeyId: msg.apiKeyId, sessionId: msg.sessionId });
      }
      break;
    }
    case 'inbound': {
      const receivedAt = new Date();
      // Inbound dedup. Two linked devices of the same number (the primary
      // and a backup worker) both receive every inbound and both report it
      // here under different sessionIds; a single worker can also retry a
      // callback. acceptInboundOnce (SET NX on the globally-unique waMessageId)
      // makes everything below (persist, admin SSE, webhook fan-out, opt-out
      // keyword handling, read receipt) run exactly once. Fail OPEN on a Redis
      // error so a real inbound is never dropped because dedup was unavailable.
      try {
        if (!(await acceptInboundOnce(env_.waMessageId))) {
          logger.debug(
            { waMessageId: env_.waMessageId },
            'duplicate inbound (second linked device or retry); skipping side effects',
          );
          break;
        }
      } catch (err: unknown) {
        logger.warn(
          { err: (err as Error).message, waMessageId: env_.waMessageId },
          'inbound dedup check failed; processing anyway (fail-open)',
        );
      }
      // Inbound dispatch needs a sessionId. Older workers may not send it;
      // fall back to resolving by workerId when a single session is bound to
      // that worker. If both fail we have no safe place to write the row, // empty-string sessionId would pollute the (sessionId, *) indexes and
      // would never appear in the admin viewer. Log loudly and 200 so the
      // worker doesn't retry; the message is best-effort visible via Sentry.
      const sessionId = env_.sessionId ?? (await resolveSessionForWorker(env_.workerId));
      if (!sessionId) {
        logger.warn(
          { workerId: env_.workerId, waMessageId: env_.waMessageId },
          'inbound without resolvable sessionId, dropping (no persistence, no dispatch)',
        );
        break;
      }
      // Customer-facing session: normalise a backup device's sessionId to the
      // pool head so persistence, SSE and webhook resolution are stable and key
      // lookup actually finds the bound keys. See resolveDispatch.
      const { sessionId: dispatchSessionId, orgId } = await resolveDispatch(sessionId);
      const fromHash = createHash('sha256').update(env_.from).digest('hex');
      // why: `env_.from` is the raw Baileys JID (e.g. `447700900456@s.whatsapp.net`);
      // the admin viewer aggregation keys threads on E.164. Derive once at
      // write-time so reads stay simple. Leaves `from` and `fromHash` alone, // dedup invariants depend on the raw JID hash.
      const fromE164 = jidToE164(env_.from);
      const inboundDoc = {
        inboundId: randomUUID(),
        sessionId: dispatchSessionId,
        workerId: env_.workerId,
        waMessageId: env_.waMessageId,
        fromHash,
        from: env_.from,
        fromE164,
        content: mapInboundContent(env_.body),
        receivedAt,
      };
      let inboundPersisted = false;
      try {
        await insertInbound(inboundDoc);
        inboundPersisted = true;
      } catch (err: unknown) {
        logger.error(
          { err: (err as Error).message, waMessageId: env_.waMessageId },
          'inbound persist failed',
        );
      }
      logger.info(
        { from: '[redacted]', waMessageId: env_.waMessageId, kind: env_.body.kind, sessionId },
        'inbound received',
      );

      // Admin SSE fan-out. DMs only, group inbound flows through
      // chat_event. Persistence-failures skip the publish so the admin
      // doesn't see an event we couldn't store.
      if (inboundPersisted && fromE164) {
        await publishAdminStream({
          kind: 'inbound',
          sessionId: dispatchSessionId,
          counterpartyE164: fromE164,
          ts: receivedAt.toISOString(),
          preview: previewFromInbound(env_.body),
          messageId: inboundDoc.inboundId,
        });
      }

      // Only dispatch when we have a webhook-compatible content shape.
      const contentForEvent = mapInboundForWebhook(env_.body);
      if (contentForEvent) {
        // Fan out to session-scoped routes AND every active API key bound to
        // this session, single dispatch call (one delivery per matching route).
        const keys = await listKeysBySession(dispatchSessionId);
        const event: WebhookEvent = {
          type: 'inbound.received',
          at: receivedAt.toISOString(),
          eventId: randomUUID(),
          sessionId: dispatchSessionId,
          waMessageId: env_.waMessageId,
          from: env_.from,
          content: contentForEvent,
        };
        dispatchEventBackground(event, {
          sessionIds: [dispatchSessionId],
          apiKeyIds: keys.map((k) => k.keyId),
        });
      }

      // Opt-out keyword handshake. Defaults to ['STOP'] when the session has
      // no per-session override. Match is case-insensitive, trimmed, exact.
      //
      // Two-step deliberate act: a lone keyword does NOT suppress the contact.
      // The FIRST keyword records a pending request (Redis, self-expiring) and
      // prompts the user to confirm. Only a SECOND keyword within the window
      // commits the opt-out. Both steps are real inbound from the customer's
      // number, so the handshake cannot be faked by the sender.
      if (env_.body.kind === 'text') {
        const text = (env_.body.text ?? '').trim().toUpperCase();
        if (text.length > 0) {
          const sessionDoc = await getSession(sessionId);
          const configured = sessionDoc?.conversation?.optOutKeywords;
          const keywords = (configured && configured.length > 0 ? configured : ['STOP']).map((k) =>
            k.toUpperCase(),
          );
          if (keywords.includes(text)) {
            // env_.from is a raw JID from the worker; convert to E.164 for storage.
            // Skip the handshake entirely for group JIDs or unresolvable numbers.
            const optPhone = jidToE164(env_.from);
            if (optPhone) {
              // Organization-scope the handshake. With two linked devices (primary + backup)
              // each STOP message is processed by whichever device wins the
              // inbound dedup race, so the two steps can land under different
              // sessionIds. Key the pending window and the opted-out view on the
              // organization, not the inbound sessionId, or the confirmation
              // never matches the window and the opt-out never commits.
              const optScope = orgId ?? dispatchSessionId;
              // A contact already on the registry texting the keyword again gets
              // no re-prompt and no duplicate write, they are already opted out.
              const alreadyOut = orgId
                ? await isOptedOutAcrossOrg(orgId, optPhone)
                : await isOptedOut(dispatchSessionId, optPhone);
              if (!alreadyOut) {
                // Atomic gate: `true` means we opened the window (first keyword),
                // `false` means a window was already open (this is the confirmation).
                // A Redis failure leaves `started` null, we then do nothing this
                // round rather than guess, and the user can retry.
                let started: boolean | null = null;
                try {
                  started = await tryStartPendingOptOut(optScope, optPhone, text);
                } catch (err: unknown) {
                  logger.error(
                    { err: (err as Error).message, sessionId, waMessageId: env_.waMessageId },
                    'opt-out pending-state persist failed',
                  );
                }
                if (started === true) {
                  // FIRST keyword, prompt for confirmation. No opt-out write,
                  // no contact.opted_out yet.
                  await sendHandshakeText(
                    sessionId,
                    optPhone,
                    `To stop receiving messages, reply ${text} once more to confirm. If this was a mistake, you can ignore this message.`,
                  );
                } else if (started === false) {
                  // SECOND keyword, confirmation. Commit the opt-out exactly as
                  // before, clear the pending state, emit contact.opted_out, and
                  // acknowledge.
                  try {
                    await addOptOut(dispatchSessionId, optPhone, 'keyword', text);
                  } catch (err: unknown) {
                    logger.error(
                      { err: (err as Error).message, sessionId, waMessageId: env_.waMessageId },
                      'opt-out keyword persist failed',
                    );
                  }
                  await clearPendingOptOut(optScope, optPhone).catch((err: unknown) =>
                    logger.warn(
                      { err: (err as Error).message, sessionId, waMessageId: env_.waMessageId },
                      'opt-out pending-state clear failed',
                    ),
                  );
                  const keys = await listKeysBySession(dispatchSessionId);
                  const optEvent: WebhookEvent = {
                    type: 'contact.opted_out',
                    sessionId: dispatchSessionId,
                    eventId: randomUUID(),
                    at: receivedAt.toISOString(),
                    phone: optPhone,
                    source: 'keyword',
                    keyword: text,
                  };
                  dispatchEventBackground(optEvent, {
                    sessionIds: [sessionId],
                    apiKeyIds: keys.map((k) => k.keyId),
                  });
                  await sendHandshakeText(
                    sessionId,
                    optPhone,
                    'You have been unsubscribed and will no longer receive messages.',
                  );
                }
              }
            }
          }
        }
      }
      break;
    }
    case 'chat_event': {
      // why: chat_event captures device-side outbound and group messages that
      // the legacy inbound/outbound paths miss. Webhook fan-out is intentionally
      // skipped, `out_device` events are our own outbound (no point webhooking
      // ourselves) and future `history_sync` events would replay ancient
      // messages as fresh notifications. Storage only.
      let chatEventPersisted = false;
      try {
        await insertChatEvent({
          sessionId: env_.sessionId,
          workerId: env_.workerId,
          waMessageId: env_.waMessageId,
          direction: env_.direction,
          source: env_.source,
          counterpartyJid: env_.counterpartyJid,
          counterpartyE164: env_.counterpartyE164,
          content: env_.content,
          ts: new Date(env_.ts),
        });
        chatEventPersisted = true;
      } catch (err: unknown) {
        logger.error(
          { err: (err as Error).message, waMessageId: env_.waMessageId, sessionId: env_.sessionId },
          'chat_event persist failed',
        );
      }

      // Admin SSE fan-out. History-sync replays would spam the live UI, so
      // we only publish live `out_device` (paired-phone outbound) and live
      // `in` (group inbound). Webhooks remain intentionally untouched here.
      if (
        chatEventPersisted &&
        (env_.direction === 'out_device' || env_.direction === 'in') &&
        env_.source === 'live'
      ) {
        await publishAdminStream({
          kind: 'chat_event',
          sessionId: env_.sessionId,
          counterpartyE164: env_.counterpartyE164,
          direction: env_.direction,
          ts: env_.ts,
          preview: previewFromChatContent(env_.content),
          waMessageId: env_.waMessageId,
        });
      }
      logger.info(
        {
          sessionId: env_.sessionId,
          waMessageId: env_.waMessageId,
          direction: env_.direction,
          source: env_.source,
          contentKind: env_.content.kind,
        },
        'chat_event received',
      );
      break;
    }
    case 'message_revision': {
      // why: edit/delete refinement is enforced manually because zod's
      // `discriminatedUnion` rejects ZodEffects members.
      if (env_.revisionKind === 'edit' && !env_.body) {
        return errorResponse(
          400,
          ErrorCodes.INVALID_BODY,
          "body is required when revisionKind is 'edit'",
          requestId,
        );
      }
      if (env_.revisionKind === 'delete') {
        if (env_.body) {
          return errorResponse(
            400,
            ErrorCodes.INVALID_BODY,
            "body must be absent when revisionKind is 'delete'",
            requestId,
          );
        }
        if (!env_.deletedBy) {
          return errorResponse(
            400,
            ErrorCodes.INVALID_BODY,
            "deletedBy is required when revisionKind is 'delete'",
            requestId,
          );
        }
      }
      // why: flatten the route-local envelope (`revisionKind`) onto the
      // protocol-shaped `MessageRevisionEvent` (`kind`) before calling the
      // repo. No webhook fan-out, revisions are admin-side capture only.
      const event: MessageRevisionEvent = {
        type: 'message_revision',
        sessionId: env_.sessionId,
        waMessageId: env_.waMessageId,
        // revisionSeq is computed by the repo from the existing ledger;
        // here we pass a placeholder that the protocol schema's refinement
        // requires but the repo overwrites.
        revisionSeq: 1,
        kind: env_.revisionKind,
        ...(env_.body !== undefined ? { body: env_.body } : {}),
        ...(env_.deletedBy !== undefined ? { deletedBy: env_.deletedBy } : {}),
        ts: env_.ts,
        source: env_.source,
      };
      try {
        const result = await insertRevisionFromEvent(event);
        logger.info(
          {
            sessionId: env_.sessionId,
            waMessageId: env_.waMessageId,
            revisionKind: env_.revisionKind,
            inserted: result.inserted,
            revisionSeq: result.revisionSeq,
            messageIdResolved: result.messageId !== null,
          },
          'message_revision received',
        );
      } catch (err: unknown) {
        logger.error(
          {
            err: (err as Error).message,
            sessionId: env_.sessionId,
            waMessageId: env_.waMessageId,
          },
          'message_revision persist failed',
        );
      }
      break;
    }
    case 'contact': {
      // why: replace-on-conflict per `(sessionId, e164)`. No webhook
      // fan-out, contact updates are reference data for the admin UI.
      const event: ContactEvent = {
        type: 'contact',
        sessionId: env_.sessionId,
        e164: env_.e164,
        waJid: env_.waJid,
        ...(env_.displayName !== undefined ? { displayName: env_.displayName } : {}),
        ...(env_.pushName !== undefined ? { pushName: env_.pushName } : {}),
        ...(env_.profilePictureUrl !== undefined
          ? { profilePictureUrl: env_.profilePictureUrl }
          : {}),
        isBusiness: env_.isBusiness,
        ...(env_.lastSeenAt !== undefined ? { lastSeenAt: env_.lastSeenAt } : {}),
        source: env_.source,
      };
      try {
        await upsertContactFromEvent(event);
        logger.info(
          { sessionId: env_.sessionId, e164: env_.e164, source: env_.source },
          'contact received',
        );
      } catch (err: unknown) {
        logger.error(
          {
            err: (err as Error).message,
            sessionId: env_.sessionId,
            e164: env_.e164,
          },
          'contact persist failed',
        );
      }
      break;
    }
    case 'group_metadata': {
      // why: replace-on-conflict per `(sessionId, jid)`, the latest fetch
      // always wins, no history kept (see GroupDocSchema). No webhook
      // fan-out: group metadata is reference data, not a message event.
      // Never log participant JIDs, subject, description, or invite code, // sessionId + participant count only.
      const doc: GroupDoc = {
        ...env_.metadata,
        sessionId: env_.sessionId,
        fetchedAt: new Date().toISOString(),
      };
      try {
        await upsertGroup(doc);
        logger.info(
          {
            sessionId: env_.sessionId,
            workerId: env_.workerId,
            jid: env_.metadata.jid,
            participantCount: env_.metadata.participants?.length ?? 0,
          },
          'group_metadata received',
        );
      } catch (err: unknown) {
        logger.error(
          {
            err: (err as Error).message,
            sessionId: env_.sessionId,
            workerId: env_.workerId,
            jid: env_.metadata.jid,
          },
          'group_metadata persist failed',
        );
      }
      break;
    }
    case 'reaction': {
      const at = new Date();
      // Normalise a backup device's sessionId to the pool head so the reaction
      // resolves the bound keys/routes and reports a stable customer id.
      const { sessionId: dispatchSessionId } = await resolveDispatch(env_.sessionId);
      // why: persistence is additive, webhook fan-out is the historical
      // contract, so a repo failure must not block the dispatch below.
      await upsertReactionFromEvent(dispatchSessionId, {
        targetWaMessageId: env_.targetWaMessageId,
        targetFromMe: env_.targetFromMe,
        fromJid: env_.fromJid,
        emoji: env_.emoji,
        at: env_.at,
      }).catch((err: unknown) => {
        logger.error(
          {
            err: (err as Error).message,
            sessionId: dispatchSessionId,
            waMessageId: env_.targetWaMessageId,
          },
          'reaction persist failed',
        );
      });

      // Match the reaction back onto the gateway-side messageId when the
      // target was an outbound message we sent. Inbound-target reactions
      // (peer reacted to a peer message we received) leave `messageId`
      // undefined, webhook consumers can still correlate on `waMessageId`.
      let matchedMessageId: string | undefined;
      if (env_.targetFromMe) {
        const matched = await findByWaMessageId(dispatchSessionId, env_.targetWaMessageId);
        matchedMessageId = matched?.messageId;
      }

      // Cross-device dedup: both linked devices report the same reaction under
      // distinct envelope nonces, so gate the webhook on a sessionId-agnostic
      // key (target + reactor + emoji + the WA-sourced timestamp), identical
      // across devices for one reaction, distinct for a genuine re-react. Persist
      // above stays unconditional (idempotent upsert). Fail OPEN on a Redis error.
      let firstReport = true;
      try {
        firstReport = await acceptOnce(
          `reaction:${env_.targetWaMessageId}:${env_.fromJid}:${env_.emoji}:${env_.at}`,
        );
      } catch {
        firstReport = true;
      }
      if (!firstReport) {
        logger.debug(
          { sessionId: dispatchSessionId, waMessageId: env_.targetWaMessageId },
          'duplicate reaction (second linked device); skipping webhook dispatch',
        );
        break;
      }

      const keys = await listKeysBySession(dispatchSessionId);
      const event: WebhookEvent = {
        type: 'inbound.reaction',
        at: at.toISOString(),
        eventId: randomUUID(),
        sessionId: dispatchSessionId,
        ...(matchedMessageId ? { messageId: matchedMessageId } : {}),
        waMessageId: env_.targetWaMessageId,
        targetFromMe: env_.targetFromMe,
        from: env_.from,
        emoji: env_.emoji,
      };
      dispatchEventBackground(event, {
        sessionIds: [dispatchSessionId],
        apiKeyIds: keys.map((k) => k.keyId),
      });
      logger.info(
        {
          sessionId: env_.sessionId,
          waMessageId: env_.targetWaMessageId,
          targetFromMe: env_.targetFromMe,
          hasEmoji: env_.emoji.length > 0,
        },
        'reaction received',
      );
      break;
    }
  }

  return jsonResponse(200, { ok: true }, requestId);
}

/**
 * Map an event's processing sessionId to the customer-facing dispatch session.
 *
 * A pooled number runs a backup linked device (e.g. M1) under a SECOND sessionId
 * that has no API keys or webhook routes bound to it. When that backup wins the
 * inbound dedup race (always, during a primary outage), resolving keys/routes by
 * its raw sessionId yields NOTHING and the webhook is silently dropped; it also
 * leaks the internal backup id into the event payload. Normalising to the
 * organization's head session (where the keys/routes live, and the stable
 * customer-facing id) fixes both. Sessions outside an organization pass
 * through unchanged, so single-session behaviour is identical.
 */
async function resolveDispatch(
  sessionId: string,
): Promise<{ sessionId: string; orgId: string | null }> {
  const org = await getOrgForSession(sessionId);
  if (!org || org.sessions.length === 0) return { sessionId, orgId: null };
  return { sessionId: org.sessions[0]!, orgId: org.orgId };
}

/** When the worker doesn't send `sessionId` on inbound, fall back to the
 *  unique session bound to that worker. Returns null when ambiguous. */
async function resolveSessionForWorker(workerId: string): Promise<string | null> {
  // Lazy import to avoid a circular hint.
  const { listSessionsByWorker } = await import('@/lib/repositories/sessions');
  const sessions = await listSessionsByWorker(workerId);
  if (sessions.length === 1) return sessions[0]!.sessionId;
  return null;
}

type InboundBody = z.infer<typeof Inbound>['body'];

/** Map the raw worker `body` shape onto the `inbound_messages` content union. */
function mapInboundContent(
  body: InboundBody,
): import('@/lib/repositories/inbound-messages').InboundMessageDoc['content'] {
  switch (body.kind) {
    case 'text':
      return { kind: 'text', text: body.text ?? '' };
    case 'image':
      return {
        kind: 'image',
        mediaUrl: body.mediaUrl,
        mediaMimeType: body.mediaMimeType,
        caption: body.caption,
      };
    case 'document':
      return {
        kind: 'document',
        mediaUrl: body.mediaUrl,
        mediaFileName: body.mediaFileName,
        mediaMimeType: body.mediaMimeType,
        caption: body.caption,
      };
    case 'audio':
    case 'video':
    case 'sticker':
    case 'other':
      return { kind: body.kind };
  }
}

/** Truncate a string for the admin live-stream preview. The `AdminStreamEvent`
 *  schema caps preview at 200 chars; we truncate just shy and append an
 *  ellipsis so clients can render "…" as an overflow hint. */
function clipPreview(s: string): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  if (flat.length <= 200) return flat;
  return `${flat.slice(0, 199)}…`;
}

function previewFromInbound(body: InboundBody): string {
  switch (body.kind) {
    case 'text':
      return clipPreview(body.text ?? '');
    case 'image':
      return clipPreview(body.caption ?? '[image]');
    case 'document':
      return clipPreview(body.caption ?? body.mediaFileName ?? '[document]');
    case 'audio':
      return '[audio]';
    case 'video':
      return '[video]';
    case 'sticker':
      return '[sticker]';
    case 'other':
      return '[message]';
  }
}

function previewFromChatContent(content: import('@hmddevs/protocol').ChatEventContent): string {
  if (content.kind === 'text') return clipPreview(content.text ?? '');
  const caption = content.media?.caption;
  if (caption) return clipPreview(caption);
  const filename = content.media?.filename;
  if (filename) return clipPreview(filename);
  return `[${content.kind}]`;
}

/** Project the worker body into the `inbound.received` webhook content shape.
 *  Returns null when the inbound type cannot be safely represented (e.g.
 *  audio/video without media URL, those are stored but not webhook-fanned). */
function mapInboundForWebhook(body: InboundBody):
  | { type: 'text'; text: string }
  | { type: 'image'; mediaUrl: string; mediaMimeType?: string; caption?: string }
  | {
      type: 'document';
      mediaUrl: string;
      mediaFileName: string;
      mediaMimeType?: string;
      caption?: string;
    }
  | null {
  if (body.kind === 'text') {
    return { type: 'text', text: body.text ?? '' };
  }
  if (body.kind === 'image' && body.mediaUrl) {
    return {
      type: 'image',
      mediaUrl: body.mediaUrl,
      mediaMimeType: body.mediaMimeType,
      caption: body.caption,
    };
  }
  if (body.kind === 'document' && body.mediaUrl && body.mediaFileName) {
    return {
      type: 'document',
      mediaUrl: body.mediaUrl,
      mediaFileName: body.mediaFileName,
      mediaMimeType: body.mediaMimeType,
      caption: body.caption,
    };
  }
  return null;
}

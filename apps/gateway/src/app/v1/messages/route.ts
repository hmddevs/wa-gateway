/**
 * POST /v1/messages, enqueue an outbound WhatsApp message.
 *
 * - Bearer API key, rate-limited.
 * - Idempotency via {apiKeyId, idempotencyKey} unique index.
 * - SSRF-guarded URL validation for image/document bodies (resolve only).
 * - Publishes a signed envelope on `wa:outbound:<workerId>` and pushes to
 *   `wa:pending:<workerId>` so the worker can pick it up even on reconnect.
 */
import 'server-only';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { ErrorCodes, GroupJidRegex, MessagePurposeSchema } from '@hmddevs/protocol';
import { authenticate, requireScope } from '@/lib/auth-api';
import { errorResponse, jsonResponse } from '@/lib/http';
import { normalisePhone } from '@/lib/phone';
import { logger } from '@/lib/logger';
import {
  insertMessage,
  findByIdempotency,
  findReplyTarget,
  listByApiKey,
  type MessageDoc,
} from '@/lib/repositories/messages';
import { getCachedSession, type SessionDoc } from '@/lib/repositories/sessions';
import { routeSend } from '@/lib/org-router';
import { refundSend, retryAfterSeconds } from '@/lib/session-state';
import { getOrg, isOptedOutAcrossOrg } from '@/lib/repositories/organizations';
import { checkRecipient } from '@/lib/rate-limit';
import { appendAudit } from '@/lib/repositories/audit';
import { isOptedOut } from '@/lib/repositories/optouts';
import { getRedis, subscribeOnce } from '@/lib/redis';
import { channels, sign, newNonce, nowIso, lpushPending } from '@/lib/wire';
import { dispatchEventBackground } from '@/lib/webhook-dispatch';
import { SendAckEnvelopeSchema } from '@hmddevs/protocol';
import { resolveSafeHost } from '@/lib/safe-fetch';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 64 * 1024;

const BodySchema = z.discriminatedUnion('kind', [
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

/** Loose phone-shape check, `normalisePhone` re-validates for real below. */
const PlausiblePhoneRegex = /^\+?[\d\s\-().]{6,20}$/;

/**
 * Loose "looks like a group JID" check, deliberately looser than
 * `GroupJidRegex`. Anything ending `@g.us` is routed to the exact-shape check
 * further down (`GroupJidRegex.test`), which returns `400 INVALID_PHONE` on a
 * malformed group JID rather than the less specific `INVALID_BODY` this
 * schema would otherwise produce.
 */
const GroupJidLikeRegex = /@g\.us$/;

const SendSchema = z.object({
  /**
   * E.164/loosely-shaped phone number OR a WhatsApp group JID
   * (`120363XXXXXXXXXXXX@g.us`) for a standalone group send.
   */
  to: z
    .string()
    .min(6)
    .max(40)
    .refine(
      (v) => PlausiblePhoneRegex.test(v) || GroupJidLikeRegex.test(v),
      'phone number or group JID',
    ),
  channel: z.enum(['notification', 'transactional', 'internal']).default('transactional'),
  /**
   * Caller-declared intent. Required, no default, every send must explicitly
   * declare its purpose so compliance routing, retention, and audit reporting
   * can categorise it. Distinct from `channel`, which gates scope/throttling.
   */
  purpose: MessagePurposeSchema,
  body: BodySchema,
  idempotencyKey: z.string().min(8).max(128).optional(),
  // TTL in seconds; default 30 minutes, max 24h.
  ttlSeconds: z.number().int().min(30).max(86_400).optional(),
  // Quote a prior message, the gateway resolves the gateway-side messageId
  // to a Baileys waMessageId before publishing the envelope.
  replyTo: z.object({ messageId: z.string().uuid() }).optional(),
  /** ISO 8601 future timestamp. When set, the message is persisted with
   *  status='scheduled' and dispatched by the scheduled-dispatch cron. */
  sendAt: z.string().datetime({ offset: true }).optional(),
  /** Opt-in synchronous-confirm mode, see protocol SendMessageRequestSchema. */
  confirm: z.boolean().optional(),
  /** Wait window for confirm-mode (300–30000 ms). */
  confirmTimeoutMs: z.number().int().min(300).max(30_000).optional(),
});

/**
 * Build the idempotent-replay 200 body. When `confirm === false` we keep the
 * historical shape exactly (no `requestId`, no `errorCode`) for back-compat
 * with existing async callers. When `confirm === true` we map the persisted
 * status onto the confirm-aware response: delivered/read collapse to 'sent'
 * (the caller asked "did it send", not "was it read"), expired collapses to
 * 'failed' with errorCode 'EXPIRED', and queued/scheduled return null so the
 * caller falls through to the live subscribe-and-wait path.
 */
function idempotentResponse(
  existing: MessageDoc,
  confirm: boolean,
  requestId: string,
): Response | null {
  if (!confirm) {
    return jsonResponse(
      200,
      { messageId: existing.messageId, status: existing.status, idempotent: true },
      requestId,
    );
  }
  switch (existing.status) {
    case 'sent':
    case 'delivered':
    case 'read':
      return jsonResponse(
        200,
        { messageId: existing.messageId, status: 'sent', idempotent: true, requestId },
        requestId,
      );
    case 'failed':
      return jsonResponse(
        200,
        {
          messageId: existing.messageId,
          status: 'failed',
          errorCode: existing.errorCode ?? 'UNKNOWN',
          idempotent: true,
          requestId,
        },
        requestId,
      );
    case 'expired':
      return jsonResponse(
        200,
        {
          messageId: existing.messageId,
          status: 'failed',
          errorCode: 'EXPIRED',
          idempotent: true,
          requestId,
        },
        requestId,
      );
    case 'scheduled':
      // The original send is parked for a future cron, no worker ack will
      // arrive on the ack channel within confirmTimeoutMs. Short-circuit to
      // 'queued' so the caller can fall back immediately rather than wait
      // out the full timeout for nothing.
      return jsonResponse(
        200,
        { messageId: existing.messageId, status: 'queued', idempotent: true, requestId },
        requestId,
      );
    case 'queued':
      // Worker may still ack the original publish, fall through to the
      // subscribe-and-wait path on the existing messageId.
      return null;
    default:
      // Defensive: unknown future status, treat as non-terminal.
      return null;
  }
}

export async function POST(req: Request): Promise<Response> {
  const auth = await authenticate(req);
  if (!auth.ok) return auth.response;
  const { apiKey, requestId } = auth;

  const len = Number(req.headers.get('content-length') ?? 0);
  if (len > MAX_BODY_BYTES) {
    return errorResponse(413, ErrorCodes.PAYLOAD_TOO_LARGE, 'Body exceeds 64KiB', requestId);
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return errorResponse(400, ErrorCodes.INVALID_BODY, 'Invalid JSON', requestId);
  }

  const parsed = SendSchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(400, ErrorCodes.INVALID_BODY, parsed.error.message, requestId);
  }
  const input = parsed.data;

  const scope =
    input.channel === 'notification'
      ? 'send:notification'
      : input.channel === 'internal'
        ? 'send:internal'
        : 'send:transactional';
  if (!requireScope(apiKey, scope)) {
    return errorResponse(403, ErrorCodes.SCOPE_DENIED, `Missing scope: ${scope}`, requestId);
  }

  // SSRF guard for media bodies: resolve-only, we never fetch here. The
  // worker (Baileys) is what actually downloads the URL, so this is the
  // trust boundary that must reject hostnames resolving to loopback,
  // link-local, RFC1918/CGNAT, or cloud-metadata addresses before the
  // message is ever persisted or published. Runs before any DB/session work
  // so a malicious media URL can't waste that work, and covers both the
  // async and confirm-mode send paths below (this check precedes the
  // branch). Text bodies are untouched. `resolveSafeHost` also enforces
  // HTTPS, so `http://` media URLs (previously accepted by the schema's
  // bare `z.string().url()`) are now rejected too; this is the intended,
  // more secure behaviour and matches the webhook URL policy. The internal
  // failure reason (URL_PRIVATE_IP, URL_NOT_HTTPS, etc.) is logged
  // server-side only; the client gets a generic message.
  if (input.body.kind === 'image' || input.body.kind === 'document') {
    try {
      await resolveSafeHost(input.body.url);
    } catch (err: unknown) {
      logger.error(
        { err: (err as Error).message, requestId, kind: input.body.kind },
        'media URL failed SSRF host validation',
      );
      return errorResponse(
        400,
        ErrorCodes.INVALID_CONTENT,
        'Media URL failed validation',
        requestId,
      );
    }
  }

  // Group JIDs (`...@g.us`) bypass phone normalisation and opt-out, see below.
  // Group quoting needs a `participantJid` the gateway doesn't resolve yet, so
  // reject it explicitly rather than silently dropping the quote.
  const isGroupJid = input.to.endsWith('@g.us');
  if (isGroupJid && input.replyTo) {
    return errorResponse(422, ErrorCodes.INVALID_BODY, 'Group quoting is not supported', requestId);
  }

  let to: string;
  if (isGroupJid) {
    if (!GroupJidRegex.test(input.to)) {
      return errorResponse(400, ErrorCodes.INVALID_PHONE, 'Invalid group JID', requestId);
    }
    to = input.to;
  } else {
    const normalised = normalisePhone(input.to);
    if (!normalised) {
      return errorResponse(400, ErrorCodes.INVALID_PHONE, 'Invalid phone number', requestId);
    }
    to = normalised;
  }

  // Opt-out and idempotency in parallel: both are pure reads, neither depends
  // on which number ends up sending, so the happy path pays max-of-RTTs.
  //
  // Session resolution deliberately does NOT join them. For an organization
  // key it *reserves* send budget (see `routeSend`), so it has to run after
  // every rejection below, otherwise a refused request permanently consumes a
  // number's capacity for the window.
  //
  // Opt-out enforcement is organization-wide for org keys: a recipient who
  // opted out on ANY member number is suppressed for all of them, so routing
  // the next message via a different number cannot bypass a STOP.
  const isScheduled = typeof input.sendAt === 'string';
  const orgId = typeof apiKey.orgId === 'string' && apiKey.orgId.length > 0 ? apiKey.orgId : null;
  const [isOut, existingIdempotent] = (await Promise.all([
    // Opt-out is phone-keyed and meaningless for a group JID, skip the
    // registry lookup entirely rather than querying with a JID.
    isGroupJid
      ? Promise.resolve(false)
      : orgId
        ? isOptedOutAcrossOrg(orgId, to)
        : isOptedOut(apiKey.sessionId, to),
    input.idempotencyKey
      ? findByIdempotency(apiKey.keyId, input.idempotencyKey)
      : Promise.resolve(null),
  ])) as [boolean, MessageDoc | null];

  // Hard block on opt-out registry. First, so opt-out is enforced even when
  // every number is degraded.
  if (isOut) {
    return errorResponse(422, ErrorCodes.OPTED_OUT, 'Recipient has opted out', requestId);
  }

  // replyTo + sendAt is unsupported: the quoted message reference would need to
  // be re-resolved at dispatch time (the waMessageId may not yet exist), and
  // the quoted target could be deleted by then. Reject explicitly rather than
  // silently dropping the quote.
  if (isScheduled && input.replyTo) {
    return errorResponse(
      422,
      ErrorCodes.INVALID_BODY,
      'sendAt cannot be combined with replyTo',
      requestId,
    );
  }

  // Validate sendAt window: ≥30s into the future, ≤30 days out. Bound checks
  // run before any DB write so retries cost nothing.
  if (isScheduled) {
    const sendAtMs = Date.parse(input.sendAt!);
    const nowMs = Date.now();
    if (Number.isNaN(sendAtMs) || sendAtMs <= nowMs + 30_000) {
      return errorResponse(
        422,
        ErrorCodes.SEND_AT_PAST,
        'sendAt must be at least 30 seconds in the future',
        requestId,
      );
    }
    if (sendAtMs > nowMs + 30 * 24 * 60 * 60 * 1_000) {
      return errorResponse(
        422,
        ErrorCodes.INVALID_BODY,
        'sendAt must be at most 30 days in the future',
        requestId,
      );
    }
  }

  const resolvedBody: MessageDoc['body'] = input.body;

  // Resolve replyTo (if provided), must be an outbound message we already
  // sent. Scoped to the organization for org keys, because the original may
  // have gone out from any of its numbers. Inbound replies are reserved for a
  // later slice.
  let quoted: { waMessageId: string; fromMe: true } | null = null;
  if (input.replyTo) {
    quoted = await findReplyTarget(
      orgId ? { orgId } : { sessionId: apiKey.sessionId },
      input.replyTo.messageId,
    );
    if (!quoted) {
      return errorResponse(
        404,
        ErrorCodes.RECIPIENT_NOT_FOUND,
        'Reply target not found in this session',
        requestId,
      );
    }
  }

  const confirm = input.confirm ?? false;
  const confirmTimeoutMs = input.confirmTimeoutMs ?? 5_000;

  // Confirm + sendAt is incoherent, confirmation describes the live send
  // round-trip, which won't happen until the cron fires. Reject explicitly.
  if (confirm && isScheduled) {
    return errorResponse(
      422,
      ErrorCodes.INVALID_BODY,
      'confirm cannot be combined with sendAt',
      requestId,
    );
  }

  // Idempotency short-circuit. Result pre-fetched in parallel above.
  if (existingIdempotent) {
    const replay = idempotentResponse(existingIdempotent, confirm, requestId);
    if (replay) return replay;
    // confirm=true with non-terminal existing status, DON'T republish; just
    // attach to the ack channel for the existing messageId and race the
    // worker's still-in-flight ack against confirmTimeoutMs.
    return await waitForAckOnly(existingIdempotent.messageId, confirmTimeoutMs, requestId);
  }

  // Resolve the number to send from. Last of the checks, because for an
  // organization key this reserves budget and every earlier rejection would
  // have leaked it.
  //
  // Scheduled sends deliberately do NOT route here: the number picked now may
  // be dead or out of budget when the cron fires an hour later, so the message
  // carries its `orgId` and is routed at dispatch time instead. It is stamped
  // with the organization's head session only so `workerId` and the viewer
  // have something coherent to key off until then.
  let session: SessionDoc | null;
  if (!orgId) {
    session = await getCachedSession(apiKey.sessionId);
    if (!session) {
      return errorResponse(503, ErrorCodes.WORKER_UNAVAILABLE, 'Session not available', requestId);
    }
    if (!isScheduled && session.status !== 'connected') {
      return errorResponse(503, ErrorCodes.WORKER_UNAVAILABLE, 'Session not available', requestId);
    }
  } else if (isScheduled) {
    const org = await getOrg(orgId);
    session = org?.sessions[0] ? await getCachedSession(org.sessions[0]) : null;
    if (!session) {
      return errorResponse(503, ErrorCodes.WORKER_UNAVAILABLE, 'Session not available', requestId);
    }
  } else {
    const routed = await routeSend(orgId, to);
    if (!routed.ok) {
      // 'all_exhausted' is a capacity answer, not an outage: every number is
      // live but over its send budget, so the caller should back off and
      // retry rather than treat it as a broken integration.
      if (routed.reason === 'all_exhausted') {
        return errorResponse(
          429,
          ErrorCodes.RATE_LIMITED,
          'All numbers for this organization are at their send limit; retry shortly',
          requestId,
          { 'Retry-After': String(retryAfterSeconds()) },
        );
      }
      return errorResponse(503, ErrorCodes.WORKER_UNAVAILABLE, 'Session not available', requestId);
    }
    session = routed.session;
  }

  // The number actually sending: the routed member for org keys, the bound
  // session otherwise. Every downstream stamp and publish uses this.
  const sendSessionId = session.sessionId;
  /** Give back the reservation when a later step refuses the send. */
  const releaseBudget = async (): Promise<void> => {
    if (orgId && !isScheduled) await refundSend(sendSessionId).catch(() => {});
  };

  // Per-recipient cap (OTP-bomb protection): global across all keys, so an
  // attacker cannot fan a flood across keys to bypass it. Skipped for
  // scheduled sends, the dispatch cron charges it when the message fires, so
  // a future-dated batch isn't counted twice.
  if (!isScheduled) {
    let recipientOk: boolean;
    try {
      recipientOk = await checkRecipient(to);
    } catch (err: unknown) {
      // Fail-closed: a limiter outage must not open the OTP-bomb hole.
      await releaseBudget();
      logger.error({ err: (err as Error).message, requestId }, 'recipient rate-limit check failed');
      return errorResponse(
        503,
        ErrorCodes.WORKER_UNAVAILABLE,
        'Rate limiter unavailable',
        requestId,
      );
    }
    if (!recipientOk) {
      await releaseBudget();
      return errorResponse(
        429,
        ErrorCodes.RATE_LIMITED,
        'Too many messages to this recipient; try again later',
        requestId,
      );
    }
  }

  const now = new Date();
  const ttlSec = input.ttlSeconds ?? 30 * 60;
  const scheduledFor = isScheduled ? new Date(input.sendAt!) : null;
  const initialStatus: MessageDoc['status'] = isScheduled ? 'scheduled' : 'queued';
  const doc: MessageDoc = {
    messageId: randomUUID(),
    apiKeyId: apiKey.keyId,
    projectId: apiKey.projectId,
    purpose: input.purpose,
    to,
    channel: input.channel,
    body: resolvedBody,
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    status: initialStatus,
    statusHistory: [{ status: initialStatus, at: now }],
    workerId: session.workerId,
    // Stamp the number that actually sends, the routed member for org keys or
    // the bound session otherwise. The worker, ack path, and viewer key off it.
    sessionId: sendSessionId,
    // Carried so the dispatch cron can re-route a SCHEDULED message when it
    // fires, rather than being stuck with a number chosen when it was enqueued.
    ...(orgId ? { orgId } : {}),
    createdAt: now,
    ttlExpiresAt: new Date(now.getTime() + ttlSec * 1_000),
    requestId,
    scheduledFor,
    dispatchedAt: null,
    // why: persist replyTo so the viewer can render the quote chrome and
    // resolve a body preview without re-hitting the wire. `quoted` was
    // already resolved above; the caller's `messageId` is the canonical
    // gateway UUID for the quoted original.
    ...(input.replyTo && quoted
      ? {
          replyTo: {
            messageId: input.replyTo.messageId,
            waMessageId: quoted.waMessageId,
            fromMe: true as const,
          },
        }
      : {}),
  };

  try {
    await insertMessage(doc);
  } catch (err: unknown) {
    // Nothing will be published on either branch below, so hand the reserved
    // capacity back rather than charging a number for a send it never made.
    await releaseBudget();
    // Duplicate idempotencyKey, race. Re-read and return.
    if (input.idempotencyKey) {
      const existing = await findByIdempotency(apiKey.keyId, input.idempotencyKey);
      if (existing) {
        const replay = idempotentResponse(existing, confirm, requestId);
        if (replay) return replay;
        return await waitForAckOnly(existing.messageId, confirmTimeoutMs, requestId);
      }
    }
    logger.error({ err: (err as Error).message, requestId }, 'insertMessage failed');
    return errorResponse(500, ErrorCodes.INTERNAL, 'Failed to enqueue message', requestId);
  }

  // Scheduled messages skip Redis publish; the scheduled-dispatch cron picks
  // them up when `scheduledFor` becomes due.
  if (isScheduled) {
    await appendAudit({
      actor: { kind: 'apiKey', id: apiKey.keyId, email: apiKey.createdBy },
      action: 'message.schedule',
      target: { kind: 'message', id: doc.messageId },
      meta: {
        channel: doc.channel,
        kind: doc.body.kind,
        projectId: doc.projectId,
        purpose: doc.purpose,
        scheduledFor: scheduledFor!.toISOString(),
      },
    }).catch((err) => logger.warn({ err: (err as Error).message }, 'audit append failed'));
    return jsonResponse(
      202,
      { messageId: doc.messageId, status: 'scheduled', scheduledFor: scheduledFor!.toISOString() },
      requestId,
    );
  }

  // Build the signed envelope once, same wire shape for confirm and async.
  // Sign failure is unrecoverable (an unsigned publish would be ignored by
  // the worker), so escalate to 500 on either path rather than the historical
  // soft-warn that left the message orphaned in `queued`.
  let wire: string;
  try {
    // why: the gateway-side envelope keeps its historical naming (`kind`,
    // `channel`, `body`) rather than the protocol's wire schema (`type`,
    // `category`, `content`). That translation seam predates the project gate;
    // `projectId` / `purpose` are appended here so the worker (which parses
    // this same shape) gets them as pass-through fields.
    const envelope = await sign({
      v: 1,
      kind: 'send' as const,
      messageId: doc.messageId,
      to: doc.to,
      body: doc.body,
      channel: doc.channel,
      projectId: doc.projectId,
      purpose: doc.purpose,
      apiKeyId: doc.apiKeyId,
      requestId,
      ...(quoted ? { quoted } : {}),
      nonce: newNonce(),
      at: nowIso(),
      sig: '',
    });
    wire = JSON.stringify(envelope);
  } catch (err: unknown) {
    logger.error(
      { err: (err as Error).message, requestId, messageId: doc.messageId },
      'envelope sign failed',
    );
    return errorResponse(500, ErrorCodes.INTERNAL, 'Failed to sign envelope', requestId);
  }

  // Side-effects shared by both response paths. Audit append is best-effort,
  // webhook fanout is background, neither blocks the response.
  const fireSideEffects = (): void => {
    appendAudit({
      actor: { kind: 'apiKey', id: apiKey.keyId, email: apiKey.createdBy },
      action: 'message.send',
      target: { kind: 'message', id: doc.messageId },
      meta: {
        channel: doc.channel,
        kind: doc.body.kind,
        projectId: doc.projectId,
        purpose: doc.purpose,
      },
    }).catch((err) => logger.warn({ err: err.message }, 'audit append failed'));
    dispatchEventBackground(
      {
        type: 'message.queued',
        at: now.toISOString(),
        eventId: randomUUID(),
        sessionId: sendSessionId,
        messageId: doc.messageId,
        to: doc.to,
        category: doc.channel,
      },
      { apiKeyId: apiKey.keyId, sessionId: sendSessionId },
    );
  };

  if (confirm) {
    // Subscribe BEFORE publishing so the worker's fast-ack can't land before
    // the listener attaches. `subscribeOnce` returns a two-stage handle: we
    // await `ready` (= SUBSCRIBE ack'd by Redis) before issuing the publish,
    // then await `message` for the worker ack or timeout.
    const ackChannel = `wa:ack:${doc.messageId}`;
    let handle;
    try {
      handle = subscribeOnce(ackChannel, confirmTimeoutMs);
      await handle.ready;
    } catch (err: unknown) {
      logger.error(
        { err: (err as Error).message, requestId, messageId: doc.messageId },
        'confirm subscribe failed',
      );
      return errorResponse(500, ErrorCodes.INTERNAL, 'Failed to attach ack listener', requestId);
    }

    try {
      const redis = getRedis();
      await Promise.all([
        lpushPending(sendSessionId, wire),
        redis.publish(channels.outbound(sendSessionId), wire),
      ]);
    } catch (err: unknown) {
      logger.error(
        { err: (err as Error).message, requestId, messageId: doc.messageId },
        'confirm publish failed',
      );
      // Drain the still-pending subscribe so it doesn't leak; the helper's
      // own timeout will resolve it to null and quit the connection.
      void handle.message.catch(() => {});
      return errorResponse(500, ErrorCodes.INTERNAL, 'Failed to publish message', requestId);
    }

    fireSideEffects();

    let raw: unknown;
    try {
      raw = await handle.message;
    } catch (err: unknown) {
      logger.error(
        { err: (err as Error).message, requestId, messageId: doc.messageId },
        'confirm subscribe wait failed',
      );
      return errorResponse(500, ErrorCodes.INTERNAL, 'Ack subscription failed', requestId);
    }

    if (raw === null) {
      // Timeout, the message MAY still arrive on WhatsApp later. Caller
      // treats `status !== 'sent'` as a fall-back trigger. 200, not 5xx.
      return jsonResponse(
        200,
        { messageId: doc.messageId, status: 'queued', requestId },
        requestId,
      );
    }
    const ack = SendAckEnvelopeSchema.safeParse(raw);
    if (!ack.success) {
      logger.error(
        { requestId, messageId: doc.messageId, err: ack.error.message },
        'confirm ack envelope failed validation',
      );
      return errorResponse(500, ErrorCodes.INTERNAL, 'Malformed ack envelope', requestId);
    }
    return jsonResponse(
      200,
      {
        messageId: doc.messageId,
        status: ack.data.status,
        ...(ack.data.errorCode ? { errorCode: ack.data.errorCode } : {}),
        requestId,
      },
      requestId,
    );
  }

  // Async path (no confirm), publish failure is non-fatal: the worker picks
  // the message up off the pending list on reconnect.
  try {
    const redis = getRedis();
    await Promise.all([
      lpushPending(sendSessionId, wire),
      redis.publish(channels.outbound(sendSessionId), wire),
    ]);
  } catch (err: unknown) {
    logger.warn(
      { err: (err as Error).message },
      'publish failed, message remains queued for worker pickup on reconnect',
    );
  }

  fireSideEffects();

  return jsonResponse(202, { messageId: doc.messageId, status: doc.status }, requestId);
}

/**
 * Confirm-mode path used when an idempotent replay finds a non-terminal
 * existing message: don't republish, just listen on the ack channel for the
 * still-in-flight worker ack and race it against `confirmTimeoutMs`.
 */
async function waitForAckOnly(
  messageId: string,
  confirmTimeoutMs: number,
  requestId: string,
): Promise<Response> {
  const ackChannel = `wa:ack:${messageId}`;
  let handle;
  try {
    handle = subscribeOnce(ackChannel, confirmTimeoutMs);
    await handle.ready;
  } catch (err: unknown) {
    logger.error(
      { err: (err as Error).message, requestId, messageId },
      'confirm-replay subscribe failed',
    );
    return errorResponse(500, ErrorCodes.INTERNAL, 'Failed to attach ack listener', requestId);
  }
  let raw: unknown;
  try {
    raw = await handle.message;
  } catch (err: unknown) {
    logger.error(
      { err: (err as Error).message, requestId, messageId },
      'confirm-replay subscribe wait failed',
    );
    return errorResponse(500, ErrorCodes.INTERNAL, 'Ack subscription failed', requestId);
  }
  if (raw === null) {
    return jsonResponse(
      200,
      { messageId, status: 'queued', idempotent: true, requestId },
      requestId,
    );
  }
  const ack = SendAckEnvelopeSchema.safeParse(raw);
  if (!ack.success) {
    logger.error(
      { requestId, messageId, err: ack.error.message },
      'confirm-replay ack envelope failed validation',
    );
    return errorResponse(500, ErrorCodes.INTERNAL, 'Malformed ack envelope', requestId);
  }
  return jsonResponse(
    200,
    {
      messageId,
      status: ack.data.status,
      ...(ack.data.errorCode ? { errorCode: ack.data.errorCode } : {}),
      idempotent: true,
      requestId,
    },
    requestId,
  );
}

/** GET /v1/messages, list messages for this key. */
export async function GET(req: Request): Promise<Response> {
  const auth = await authenticate(req);
  if (!auth.ok) return auth.response;
  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 50), 200);
  const before = url.searchParams.get('before') ?? undefined;
  const docs = await listByApiKey(auth.apiKey.keyId, { limit, beforeId: before });
  return jsonResponse(
    200,
    {
      messages: docs.map((m) => ({
        messageId: m.messageId,
        to: m.to,
        channel: m.channel,
        purpose: m.purpose,
        status: m.status,
        createdAt: m.createdAt,
        body: { kind: m.body.kind },
      })),
    },
    auth.requestId,
  );
}

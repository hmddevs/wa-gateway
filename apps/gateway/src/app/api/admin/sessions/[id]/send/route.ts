/**
 * POST /api/admin/sessions/:id/send
 *
 * Sends a WhatsApp message on behalf of an admin. Requires WebAuthn step-up.
 * Uses sentinel apiKeyId '__admin__' so the message is distinguishable in
 * queries without coupling admin sends to any live API key.
 */
import 'server-only';
import { randomUUID } from 'node:crypto';
import {
  AdminSendRequestSchema,
  ErrorCodes,
  MessagePurposeSchema,
  SessionIdSchema,
} from '@hmddevs/protocol';
import { requireAdmin } from '@/lib/require-admin';
import { errorResponse, jsonResponse } from '@/lib/http';
import { mintRequestId } from '@/lib/request-id';
import { adminLimiterKey, checkAdminLimit } from '@/lib/admin-rate-limit';
import { getSession } from '@/lib/repositories/sessions';
import { findReplyTarget, insertMessage, type MessageDoc } from '@/lib/repositories/messages';
import { isOptedOut } from '@/lib/repositories/optouts';
import { appendAudit } from '@/lib/repositories/audit';
import { normalisePhone } from '@/lib/phone';
import { getRedis } from '@/lib/redis';
import { channels, newNonce, nowIso, sign, lpushPending } from '@/lib/wire';
import { logger } from '@/lib/logger';
import { resolveSafeHost } from '@/lib/safe-fetch';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 64 * 1024;

/**
 * Sentinel projectId for admin-originated sends. `ProjectIdSchema`'s regex
 * forbids leading/trailing dashes and underscores, so `__admin__` would fail
 * validation. `admin-console` satisfies the regex, reads clearly in audit, and
 * keeps `projectId` strictly required across the doc shape.
 */
const ADMIN_PROJECT_ID = 'admin-console';

/**
 * Extend the protocol's admin-send request with the new project/purpose fields
 * locally rather than editing the protocol package: the gate didn't add these
 * to `AdminSendRequestSchema`, but the gateway still needs to capture intent
 * on admin sends so audits and downstream compliance categorisation work.
 */
const AdminSendBodySchema = AdminSendRequestSchema.extend({
  purpose: MessagePurposeSchema,
});

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = mintRequestId(req.headers.get('x-request-id'));

  const guard = await requireAdmin({ webauthn: true });
  if (!guard.ok) {
    return errorResponse(guard.status, ErrorCodes.UNAUTHORIZED, guard.message, requestId);
  }

  const { id: rawId } = await ctx.params;
  const idParse = SessionIdSchema.safeParse(rawId);
  if (!idParse.success) {
    return errorResponse(400, ErrorCodes.INVALID_BODY, 'Invalid session id', requestId);
  }
  const sessionId = idParse.data;

  const ok = await checkAdminLimit(adminLimiterKey(guard.admin));
  if (!ok) {
    return errorResponse(429, ErrorCodes.RATE_LIMITED, 'Too many admin requests', requestId);
  }

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

  const parsed = AdminSendBodySchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(400, ErrorCodes.INVALID_BODY, parsed.error.message, requestId);
  }
  const input = parsed.data;

  const isGroupJid = input.to.endsWith('@g.us');
  const to = isGroupJid ? input.to : normalisePhone(input.to);
  if (!to) {
    return errorResponse(400, ErrorCodes.INVALID_PHONE, 'Invalid phone number', requestId);
  }

  // SSRF guard for media bodies: resolve-only, mirrors /v1/messages. The
  // internal failure reason is logged server-side only; the client gets a
  // generic message and the caller URL is never logged.
  if (input.body.kind === 'image' || input.body.kind === 'document') {
    try {
      await resolveSafeHost(input.body.url);
    } catch (err: unknown) {
      logger.error(
        { err: (err as Error).message, requestId, kind: input.body.kind },
        'admin send media URL failed SSRF host validation',
      );
      return errorResponse(
        400,
        ErrorCodes.INVALID_CONTENT,
        'Media URL failed validation',
        requestId,
      );
    }
  }

  if (!isGroupJid && (await isOptedOut(sessionId, to))) {
    return errorResponse(422, ErrorCodes.OPTED_OUT, 'Recipient has opted out', requestId);
  }

  const session = await getSession(sessionId);
  if (!session) {
    return errorResponse(404, ErrorCodes.INVALID_BODY, 'Session not found', requestId);
  }
  if (session.status !== 'connected') {
    return errorResponse(503, ErrorCodes.WORKER_UNAVAILABLE, 'Session not connected', requestId);
  }

  let quoted: { waMessageId: string; fromMe: true } | null = null;
  if (input.replyTo) {
    quoted = await findReplyTarget({ sessionId }, input.replyTo.messageId);
    if (!quoted) {
      return errorResponse(
        404,
        ErrorCodes.RECIPIENT_NOT_FOUND,
        'Reply target not found in this session',
        requestId,
      );
    }
  }

  const now = new Date();
  const messageId = randomUUID();
  const doc: MessageDoc = {
    messageId,
    apiKeyId: '__admin__',
    projectId: ADMIN_PROJECT_ID,
    purpose: input.purpose,
    to,
    channel: 'internal',
    body: input.body,
    idempotencyKey: messageId,
    status: 'queued',
    statusHistory: [{ status: 'queued', at: now }],
    workerId: session.workerId,
    sessionId,
    createdAt: now,
    ttlExpiresAt: new Date(now.getTime() + 30 * 60 * 1_000),
    requestId,
    scheduledFor: null,
    dispatchedAt: null,
    origin: 'admin',
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
    logger.error({ err: (err as Error).message, requestId }, 'admin insertMessage failed');
    return errorResponse(500, ErrorCodes.INTERNAL, 'Failed to enqueue message', requestId);
  }

  try {
    // why: gateway-side envelope shape, `kind`/`channel`/`body` plus new
    // project/purpose pass-through fields. Worker reads this same shape.
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
    const redis = getRedis();
    const wire = JSON.stringify(envelope);
    await Promise.all([
      lpushPending(sessionId, wire),
      redis.publish(channels.outbound(sessionId), wire),
    ]);
  } catch (err: unknown) {
    logger.warn({ err: (err as Error).message }, 'publish failed, message remains queued');
  }

  await appendAudit({
    actor: { kind: 'admin', id: guard.admin.email, email: guard.admin.email },
    action: 'message.send.admin',
    target: { kind: 'message', id: doc.messageId },
    meta: {
      sessionId,
      to,
      kind: doc.body.kind,
      projectId: doc.projectId,
      purpose: doc.purpose,
    },
  }).catch((err: unknown) => logger.warn({ err: (err as Error).message }, 'audit append failed'));

  return jsonResponse(201, { messageId: doc.messageId, status: 'queued' }, requestId);
}

/**
 * POST   /v1/messages/:id/reactions, set a reaction on a prior outbound message.
 * DELETE /v1/messages/:id/reactions, clear the reaction (sends empty emoji).
 *
 * Reactions ride the same `wa:outbound:<sessionId>` channel as `send` envelopes
 * but with `kind: 'react'`. They are fire-and-forget at the Baileys layer,
 * however we still push to the pending list so the worker drains them in order
 * after a reconnect, matching the send path.
 */
import 'server-only';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { ErrorCodes, ReactionRequestSchema } from '@hmddevs/protocol';
import { authenticate, requireScope } from '@/lib/auth-api';
import { errorResponse, jsonResponse } from '@/lib/http';
import { mintRequestId } from '@/lib/request-id';
import { jidFromE164 } from '@/lib/phone';
import { logger } from '@/lib/logger';
import { findByMessageId } from '@/lib/repositories/messages';
import { getCachedSession } from '@/lib/repositories/sessions';
import { appendAudit } from '@/lib/repositories/audit';
import { getRedis } from '@/lib/redis';
import { channels, sign, newNonce, nowIso, lpushPending } from '@/lib/wire';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 64 * 1024;

interface ReactDispatch {
  emoji: string;
  action: 'message.react' | 'message.unreact';
}

async function dispatch(
  req: Request,
  params: Promise<{ id: string }>,
  payload: ReactDispatch,
): Promise<Response> {
  const auth = await authenticate(req);
  if (!auth.ok) return auth.response;
  const { apiKey, requestId } = auth;

  if (!requireScope(apiKey, 'send:transactional')) {
    return errorResponse(
      403,
      ErrorCodes.SCOPE_DENIED,
      'Missing scope: send:transactional',
      requestId,
    );
  }

  const { id: targetMessageId } = await params;
  if (!z.string().uuid().safeParse(targetMessageId).success) {
    return errorResponse(400, ErrorCodes.INVALID_BODY, 'Invalid messageId', requestId);
  }

  const msg = await findByMessageId(targetMessageId);
  if (!msg || msg.sessionId !== apiKey.sessionId) {
    // Either the message doesn't exist, or it belongs to a different session.
    // Same response either way, don't leak existence across tenants.
    return errorResponse(404, ErrorCodes.RECIPIENT_NOT_FOUND, 'Message not found', requestId);
  }
  if (!msg.waMessageId) {
    return errorResponse(
      422,
      ErrorCodes.INVALID_REACTION,
      "Cannot react to message that hasn't been sent yet",
      requestId,
    );
  }

  const session = await getCachedSession(apiKey.sessionId);
  if (!session || session.status !== 'connected') {
    return errorResponse(503, ErrorCodes.WORKER_UNAVAILABLE, 'Session not available', requestId);
  }

  const waJid = jidFromE164(msg.to);
  if (!waJid) {
    return errorResponse(
      500,
      ErrorCodes.INTERNAL,
      'Stored recipient is not a valid E.164',
      requestId,
    );
  }

  const opMessageId = randomUUID();
  try {
    const envelope = await sign({
      v: 1,
      kind: 'react' as const,
      messageId: opMessageId,
      to: msg.to,
      waJid,
      targetWaMessageId: msg.waMessageId,
      targetFromMe: true as const,
      emoji: payload.emoji,
      apiKeyId: apiKey.keyId,
      requestId,
      nonce: newNonce(),
      at: nowIso(),
      sig: '',
    });
    const wire = JSON.stringify(envelope);
    const redis = getRedis();
    await Promise.all([
      lpushPending(apiKey.sessionId, wire),
      redis.publish(channels.outbound(apiKey.sessionId), wire),
    ]);
  } catch (err: unknown) {
    logger.error({ err: (err as Error).message, requestId }, 'reaction publish failed');
    return errorResponse(500, ErrorCodes.INTERNAL, 'Failed to enqueue reaction', requestId);
  }

  await appendAudit({
    actor: { kind: 'apiKey', id: apiKey.keyId, email: apiKey.createdBy },
    action: payload.action,
    target: { kind: 'message', id: targetMessageId },
    meta: { emoji: payload.emoji, sessionId: apiKey.sessionId },
  }).catch((err) => logger.warn({ err: err.message }, 'audit append failed'));

  return jsonResponse(
    202,
    { messageId: opMessageId, emoji: payload.emoji, status: 'queued' as const },
    requestId,
  );
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = mintRequestId(req.headers.get('x-request-id'));

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

  const parsed = ReactionRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(422, ErrorCodes.INVALID_REACTION, parsed.error.message, requestId);
  }
  if (parsed.data.emoji.length === 0) {
    // Clearing belongs on DELETE, POST always sets a reaction.
    return errorResponse(
      422,
      ErrorCodes.INVALID_REACTION,
      'Empty emoji, use DELETE to clear a reaction',
      requestId,
    );
  }

  return dispatch(req, ctx.params, { emoji: parsed.data.emoji, action: 'message.react' });
}

export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  // No body parsing, DELETE clears the reaction unconditionally.
  return dispatch(req, ctx.params, { emoji: '', action: 'message.unreact' });
}

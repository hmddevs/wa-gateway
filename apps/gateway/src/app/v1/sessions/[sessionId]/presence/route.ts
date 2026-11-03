/**
 * POST /v1/sessions/:sessionId/presence
 *
 * Push a presence update (typing/recording/online indicator) for this session.
 * Fire-and-forget, there is no `wa:pending` queue entry. If the worker is
 * disconnected the update is simply dropped, which is the correct semantics
 * for ephemeral presence.
 */
import 'server-only';
import { randomUUID } from 'node:crypto';
import { ErrorCodes, PresenceRequestSchema } from '@hmddevs/protocol';
import { authenticate, requireScope } from '@/lib/auth-api';
import { errorResponse, jsonResponse } from '@/lib/http';
import { normalisePhone, jidFromE164 } from '@/lib/phone';
import { logger } from '@/lib/logger';
import { getCachedSession } from '@/lib/repositories/sessions';
import { appendAudit } from '@/lib/repositories/audit';
import { getRedis } from '@/lib/redis';
import { channels, sign, newNonce, nowIso } from '@/lib/wire';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 64 * 1024;

export async function POST(
  req: Request,
  ctx: { params: Promise<{ sessionId: string }> },
): Promise<Response> {
  const auth = await authenticate(req);
  if (!auth.ok) return auth.response;
  const { apiKey, requestId } = auth;

  const { sessionId: pathSessionId } = await ctx.params;
  if (pathSessionId !== apiKey.sessionId) {
    return errorResponse(
      403,
      ErrorCodes.SCOPE_DENIED,
      'API key not bound to this session',
      requestId,
    );
  }

  if (!requireScope(apiKey, 'send:transactional')) {
    return errorResponse(
      403,
      ErrorCodes.SCOPE_DENIED,
      'Missing scope: send:transactional',
      requestId,
    );
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

  const parsed = PresenceRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(422, ErrorCodes.INVALID_PRESENCE_STATE, parsed.error.message, requestId);
  }
  const input = parsed.data;

  let waJid: string | undefined;
  if (input.to) {
    const e164 = normalisePhone(input.to);
    if (!e164) {
      return errorResponse(400, ErrorCodes.INVALID_PHONE, 'Invalid phone number', requestId);
    }
    const jid = jidFromE164(e164);
    if (!jid) {
      return errorResponse(400, ErrorCodes.INVALID_PHONE, 'Invalid phone number', requestId);
    }
    waJid = jid;
  }

  const session = await getCachedSession(apiKey.sessionId);
  if (!session || session.status !== 'connected') {
    return errorResponse(503, ErrorCodes.WORKER_UNAVAILABLE, 'Session not available', requestId);
  }

  try {
    const envelope = await sign({
      v: 1,
      kind: 'presence' as const,
      messageId: randomUUID(),
      state: input.state,
      ...(waJid ? { waJid } : {}),
      apiKeyId: apiKey.keyId,
      requestId,
      nonce: newNonce(),
      at: nowIso(),
      sig: '',
    });
    const redis = getRedis();
    await redis.publish(channels.outbound(apiKey.sessionId), JSON.stringify(envelope));
  } catch (err: unknown) {
    logger.warn(
      { err: (err as Error).message, requestId },
      'presence publish failed, best-effort, dropping',
    );
  }

  await appendAudit({
    actor: { kind: 'apiKey', id: apiKey.keyId, email: apiKey.createdBy },
    action: 'session.presence',
    target: { kind: 'session', id: apiKey.sessionId },
    meta: { state: input.state, hasTarget: Boolean(input.to) },
  }).catch((err) => logger.warn({ err: err.message }, 'audit append failed'));

  return jsonResponse(200, { status: 'queued' as const }, requestId);
}

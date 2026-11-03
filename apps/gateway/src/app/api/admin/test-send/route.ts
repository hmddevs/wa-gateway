/**
 * POST /api/admin/test-send
 *
 * Admin-gated proxy: runs the full v1/messages send pipeline using an existing
 * API key (looked up by keyId, no plaintext required). Used by the API test
 * panel in the admin UI. Audited as `api_key.test_send`.
 *
 * Differences from v1/messages:
 *   - Auth is WebAuthn admin, not bearer token.
 *   - Key rate-limiter is bypassed (admin override).
 *   - Idempotency, scheduling, and sendAt are not supported.
 *   - Response includes `latencyMs`.
 */
import 'server-only';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { ErrorCodes, MessagePurposeSchema } from '@hmddevs/protocol';
import { requireAdmin } from '@/lib/require-admin';
import { errorResponse, jsonResponse } from '@/lib/http';
import { mintRequestId } from '@/lib/request-id';
import { adminLimiterKey, checkAdminLimit } from '@/lib/admin-rate-limit';
import { findById as findKeyById } from '@/lib/repositories/api-keys';
import { getSession } from '@/lib/repositories/sessions';
import { insertMessage, findReplyTarget, type MessageDoc } from '@/lib/repositories/messages';
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

const TestSendSchema = z.object({
  keyId: z.string().min(1),
  to: z.string().min(6).max(20),
  channel: z.enum(['notification', 'transactional', 'internal']).default('transactional'),
  /** Mirrors `/v1/messages`, required, no default. The admin UI's API test
   *  panel forwards whatever the operator selected; the impersonated send
   *  still records explicit intent in audits. */
  purpose: MessagePurposeSchema,
  body: BodySchema,
  replyTo: z.object({ messageId: z.string().uuid() }).optional(),
});

export async function POST(req: Request): Promise<Response> {
  const requestId = mintRequestId(req.headers.get('x-request-id'));

  const guard = await requireAdmin({ webauthn: true });
  if (!guard.ok) {
    return errorResponse(guard.status, ErrorCodes.UNAUTHORIZED, guard.message, requestId);
  }

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

  const parsed = TestSendSchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(400, ErrorCodes.INVALID_BODY, parsed.error.message, requestId);
  }
  const input = parsed.data;

  const pipelineStart = Date.now();

  const apiKey = await findKeyById(input.keyId);
  if (!apiKey) {
    return errorResponse(404, ErrorCodes.INVALID_BODY, 'API key not found', requestId);
  }
  if (apiKey.revokedAt) {
    return errorResponse(422, ErrorCodes.INVALID_BODY, 'API key has been revoked', requestId);
  }

  const scope =
    input.channel === 'notification'
      ? 'send:notification'
      : input.channel === 'internal'
        ? 'send:internal'
        : 'send:transactional';
  if (!apiKey.scopes.includes(scope)) {
    return errorResponse(403, ErrorCodes.SCOPE_DENIED, `Key missing scope: ${scope}`, requestId);
  }

  const to = normalisePhone(input.to);
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
        'test-send media URL failed SSRF host validation',
      );
      return errorResponse(
        400,
        ErrorCodes.INVALID_CONTENT,
        'Media URL failed validation',
        requestId,
      );
    }
  }

  if (await isOptedOut(apiKey.sessionId, to)) {
    return errorResponse(422, ErrorCodes.OPTED_OUT, 'Recipient has opted out', requestId);
  }

  const session = await getSession(apiKey.sessionId);
  if (!session) {
    return errorResponse(503, ErrorCodes.WORKER_UNAVAILABLE, 'Session not available', requestId);
  }
  if (session.status !== 'connected') {
    return errorResponse(503, ErrorCodes.WORKER_UNAVAILABLE, 'Session not connected', requestId);
  }

  const resolvedBody: MessageDoc['body'] = input.body;

  let quoted: { waMessageId: string; fromMe: true } | null = null;
  if (input.replyTo) {
    quoted = await findReplyTarget({ sessionId: apiKey.sessionId }, input.replyTo.messageId);
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
    apiKeyId: apiKey.keyId,
    projectId: apiKey.projectId,
    purpose: input.purpose,
    to,
    channel: input.channel,
    body: resolvedBody,
    status: 'queued',
    statusHistory: [{ status: 'queued', at: now }],
    workerId: session.workerId,
    sessionId: apiKey.sessionId,
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
    logger.error({ err: (err as Error).message, requestId }, 'test-send insertMessage failed');
    return errorResponse(500, ErrorCodes.INTERNAL, 'Failed to enqueue message', requestId);
  }

  try {
    // why: same gateway-side envelope shape as /v1/messages, worker reads
    // `kind`/`channel`/`body` plus the new pass-through fields.
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
      lpushPending(apiKey.sessionId, wire),
      redis.publish(channels.outbound(apiKey.sessionId), wire),
    ]);
  } catch (err: unknown) {
    logger.warn(
      { err: (err as Error).message },
      'test-send publish failed, message remains queued',
    );
  }

  const latencyMs = Date.now() - pipelineStart;

  await appendAudit({
    actor: { kind: 'admin', id: guard.admin.email, email: guard.admin.email },
    action: 'api_key.test_send',
    target: { kind: 'message', id: doc.messageId },
    meta: {
      keyId: apiKey.keyId,
      sessionId: apiKey.sessionId,
      to,
      channel: input.channel,
      kind: resolvedBody.kind,
      projectId: doc.projectId,
      purpose: doc.purpose,
    },
  }).catch((err: unknown) =>
    logger.warn({ err: (err as Error).message }, 'test-send audit append failed'),
  );

  return jsonResponse(201, { messageId: doc.messageId, status: 'queued', latencyMs }, requestId);
}

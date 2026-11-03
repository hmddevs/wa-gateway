/**
 * Admin session detail, conversation toggle, and deletion.
 * GET    /api/admin/sessions/:id, fetch a single session
 * PATCH  /api/admin/sessions/:id, update conversation + routing config (no step-up)
 * DELETE /api/admin/sessions/:id, stop a session (WebAuthn step-up required)
 */
import 'server-only';
import { z } from 'zod';
import { requireAdmin } from '@/lib/require-admin';
import { errorResponse, jsonResponse } from '@/lib/http';
import { ErrorCodes, SessionBudgetSchema } from '@hmddevs/protocol';
import { mintRequestId } from '@/lib/request-id';
import {
  getSession,
  upsertSession,
  deleteSession,
  updateConversationConfig,
  updateRoutingConfig,
  invalidateSessionCache,
} from '@/lib/repositories/sessions';
import { appendAudit } from '@/lib/repositories/audit';
import { getRedis } from '@/lib/redis';
import { channels, sign, newNonce, nowIso } from '@/lib/wire';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = mintRequestId(req.headers.get('x-request-id'));
  const guard = await requireAdmin();
  if (!guard.ok)
    return errorResponse(guard.status, ErrorCodes.UNAUTHORIZED, guard.message, requestId);

  const { id } = await params;
  const session = await getSession(id);
  if (!session) return errorResponse(404, ErrorCodes.INVALID_BODY, 'Session not found', requestId);
  return jsonResponse(200, { session }, requestId);
}

const PatchSchema = z
  .object({
    conversation: z
      .object({
        sendReadReceipts: z.boolean().optional(),
        /** Trimmed, ≤32-char keywords. Empty array clears overrides
         *  (renderer falls back to ['STOP']). */
        optOutKeywords: z.array(z.string().trim().min(1).max(32)).max(10).optional(),
      })
      .optional(),
    /** Take this number out of send rotation without disconnecting it. Inbound
     *  keeps working; only `org-router` honours the flag. */
    paused: z.boolean().optional(),
    /** Per-number send caps. Omit to keep the router's defaults. */
    budget: SessionBudgetSchema.optional(),
  })
  // Tolerate unknown top-level keys, keeps the surface narrow but lets
  // future fields land without an immediate breaking change for admins.
  .passthrough();

const MAX_BODY_BYTES = 16 * 1024;

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = mintRequestId(req.headers.get('x-request-id'));
  const guard = await requireAdmin();
  if (!guard.ok)
    return errorResponse(guard.status, ErrorCodes.UNAUTHORIZED, guard.message, requestId);

  const len = Number(req.headers.get('content-length') ?? 0);
  if (len > MAX_BODY_BYTES) {
    return errorResponse(413, ErrorCodes.PAYLOAD_TOO_LARGE, 'Body too large', requestId);
  }

  const { id } = await params;
  const session = await getSession(id);
  if (!session) return errorResponse(404, ErrorCodes.INVALID_BODY, 'Session not found', requestId);

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return errorResponse(400, ErrorCodes.INVALID_BODY, 'Invalid JSON', requestId);
  }

  const parsed = PatchSchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(400, ErrorCodes.INVALID_BODY, parsed.error.message, requestId);
  }

  const before = {
    sendReadReceipts: session.conversation?.sendReadReceipts ?? true,
    optOutKeywords: session.conversation?.optOutKeywords,
  };
  const conv = parsed.data.conversation ?? {};

  const conversationUpdated = await updateConversationConfig(id, {
    ...(typeof conv.sendReadReceipts === 'boolean'
      ? { sendReadReceipts: conv.sendReadReceipts }
      : {}),
    ...(Array.isArray(conv.optOutKeywords) ? { optOutKeywords: conv.optOutKeywords } : {}),
  });
  if (!conversationUpdated) {
    return errorResponse(404, ErrorCodes.INVALID_BODY, 'Session not found', requestId);
  }

  // Routing config is a separate write because it lives at the top level of the
  // doc, not under `conversation`. Second call rather than a merged one so the
  // conversation repo keeps its narrow, dotted-path contract.
  const updated =
    (await updateRoutingConfig(id, {
      ...(typeof parsed.data.paused === 'boolean' ? { paused: parsed.data.paused } : {}),
      ...(parsed.data.budget ? { budget: parsed.data.budget } : {}),
    })) ?? conversationUpdated;

  // Invalidate cache after Mongo write (fire-and-forget).
  invalidateSessionCache(id).catch(() => {});

  const after = {
    sendReadReceipts: updated.conversation?.sendReadReceipts ?? true,
    optOutKeywords: updated.conversation?.optOutKeywords,
  };

  await appendAudit({
    actor: { kind: 'admin', id: guard.admin.email, email: guard.admin.email },
    action: 'session.conversation.update',
    target: { kind: 'session', id },
    meta: { before, after },
  }).catch((err) => logger.warn({ err: (err as Error).message }, 'audit append failed'));

  return jsonResponse(200, { session: updated }, requestId);
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = mintRequestId(req.headers.get('x-request-id'));
  const guard = await requireAdmin({ webauthn: true });
  if (!guard.ok)
    return errorResponse(guard.status, ErrorCodes.UNAUTHORIZED, guard.message, requestId);

  const { id } = await params;
  const session = await getSession(id);
  if (!session) return errorResponse(404, ErrorCodes.INVALID_BODY, 'Session not found', requestId);

  const workerId = session.workerId ?? env.WORKER_ID;

  // Signal the worker to stop this session.
  try {
    const envelope = await sign({
      type: 'control' as const,
      action: 'stop_session' as const,
      sessionId: id,
      nonce: newNonce(),
      at: nowIso(),
      sig: '',
    });
    const redis = getRedis();
    await redis.publish(channels.control(workerId), JSON.stringify(envelope));
  } catch (err: unknown) {
    void err;
  }

  await deleteSession(id);

  // Invalidate cache after deletion (fire-and-forget).
  invalidateSessionCache(id).catch(() => {});

  await appendAudit({
    actor: { kind: 'admin', id: guard.admin.email, email: guard.admin.email },
    action: 'session.delete',
    target: { kind: 'session', id },
    meta: { workerId },
  }).catch(() => {});

  return jsonResponse(200, { ok: true }, requestId);
}

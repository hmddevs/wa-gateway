/**
 * GET /v1/messages/:id, detailed status for a single message.
 */
import 'server-only';
import { ErrorCodes } from '@hmddevs/protocol';
import { authenticate } from '@/lib/auth-api';
import { errorResponse, jsonResponse } from '@/lib/http';
import { findByMessageId } from '@/lib/repositories/messages';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = await authenticate(req);
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  const doc = await findByMessageId(id);
  if (!doc || doc.apiKeyId !== auth.apiKey.keyId) {
    return errorResponse(404, ErrorCodes.INVALID_BODY, 'Not found', auth.requestId);
  }
  return jsonResponse(
    200,
    {
      messageId: doc.messageId,
      to: doc.to,
      channel: doc.channel,
      purpose: doc.purpose,
      status: doc.status,
      statusHistory: doc.statusHistory,
      createdAt: doc.createdAt,
      ttlExpiresAt: doc.ttlExpiresAt,
      errorCode: doc.errorCode,
      body: { kind: doc.body.kind },
    },
    auth.requestId,
  );
}

/**
 * POST /api/admin/webauthn/authenticate/begin
 * POST /api/admin/webauthn/authenticate/finish
 *
 * On `finish` success we:
 *   1. Ensure an admin_sessions doc exists (create if first step-up).
 *   2. Mark `webauthnVerifiedAt = now` so sensitive routes unlock.
 */
import 'server-only';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { beginAuthentication, finishAuthentication } from '@/lib/webauthn';
import { mintRequestId } from '@/lib/request-id';
import { errorResponse, jsonResponse } from '@/lib/http';
import { ErrorCodes } from '@hmddevs/protocol';
import { adminEmailAllowlist } from '@/lib/env';
import { createAdminSession, currentAdminSessionId, markStepUpComplete } from '@/lib/admin-session';
import { appendAudit } from '@/lib/repositories/audit';
import { getClientIp } from '@/lib/auth-api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  const requestId = mintRequestId(req.headers.get('x-request-id'));
  const session = await auth();
  const email = session?.user?.email?.toLowerCase();
  if (!email || !adminEmailAllowlist().includes(email)) {
    return errorResponse(401, ErrorCodes.UNAUTHORIZED, 'Not signed in', requestId);
  }
  const phase = new URL(req.url).pathname.endsWith('/begin') ? 'begin' : 'finish';

  try {
    if (phase === 'begin') {
      const opts = await beginAuthentication(email);
      return jsonResponse(200, opts, requestId);
    }
    const BodySchema = z.object({ response: z.unknown() });
    const parsed = BodySchema.parse(await req.json());
    await finishAuthentication(email, parsed.response);

    let sid = await currentAdminSessionId();
    if (!sid) {
      sid = await createAdminSession({
        email,
        ip: getClientIp(req),
        userAgent: req.headers.get('user-agent') ?? '',
      });
    }
    await markStepUpComplete();
    await appendAudit({
      actor: { kind: 'admin', id: email, email },
      action: 'admin.webauthn.stepup',
      ip: getClientIp(req),
      userAgent: req.headers.get('user-agent') ?? undefined,
    }).catch(() => {});
    return jsonResponse(200, { ok: true }, requestId);
  } catch (err) {
    return errorResponse(400, ErrorCodes.INVALID_BODY, (err as Error).message, requestId);
  }
}

/**
 * POST /api/admin/webauthn/register/begin
 * POST /api/admin/webauthn/register/finish
 */
import 'server-only';
import { auth } from '@/lib/auth';
import { beginRegistration, finishRegistration } from '@/lib/webauthn';
import { mintRequestId } from '@/lib/request-id';
import { errorResponse, jsonResponse } from '@/lib/http';
import { ErrorCodes } from '@hmddevs/protocol';
import { adminEmailAllowlist } from '@/lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  const requestId = mintRequestId(req.headers.get('x-request-id'));
  const session = await auth();
  const email = session?.user?.email?.toLowerCase();
  if (!email || !adminEmailAllowlist().includes(email)) {
    return errorResponse(401, ErrorCodes.UNAUTHORIZED, 'Not signed in', requestId);
  }

  const url = new URL(req.url);
  const phase = url.pathname.endsWith('/begin') ? 'begin' : 'finish';

  try {
    if (phase === 'begin') {
      const opts = await beginRegistration(email);
      return jsonResponse(200, opts, requestId);
    }
    const body = (await req.json()) as { response: unknown; deviceName?: string };
    const result = await finishRegistration(email, body.response, body.deviceName);
    return jsonResponse(200, result, requestId);
  } catch (err) {
    const msg = (err as Error).message;
    return errorResponse(400, ErrorCodes.INVALID_BODY, msg, requestId);
  }
}

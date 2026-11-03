/**
 * GET /api/pair/:token/status
 *
 * Public, UNAUTHENTICATED. Backs the shareable pairing page: the state of the
 * link and of every number added through it, so the holder can watch a QR
 * appear, scan it, and immediately add another.
 *
 * SECURITY:
 *   - IP rate-limited via the same `checkIp` bucket as the public send API.
 *   - `verifyInvite` failure (malformed token, unknown lookup hash, hash
 *     mismatch) always 404s with the same body, never an existence oracle.
 *   - Discloses only what the link's holder needs and already owns: the
 *     organization's label, and for each number they added, its id, state and
 *     last four digits. Deliberately NOT the full phone number, the worker id,
 *     `createdBy`, or anything about numbers they did not add through this
 *     link, the token travels in a URL and may be forwarded.
 *   - `noindex` is applied globally by the middleware (see security-headers.ts).
 */
import 'server-only';
import { errorResponse, jsonResponse } from '@/lib/http';
import { ErrorCodes } from '@hmddevs/protocol';
import { mintRequestId } from '@/lib/request-id';
import { checkIp } from '@/lib/rate-limit';
import { getClientIp } from '@/lib/auth-api';
import { verifyInvite } from '@/lib/pairing-invite';
import { markInviteExpired } from '@/lib/repositories/pairing-invites';
import { getSession } from '@/lib/repositories/sessions';
import { getOrg } from '@/lib/repositories/organizations';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export type PairNumberState = 'pairing' | 'connected' | 'offline';

export interface PairNumberView {
  sessionId: string;
  state: PairNumberState;
  /** Last four digits only, enough to tell two numbers apart, no more. */
  last4: string | null;
  qrDataUrl?: string;
}

export interface PairViewBody {
  status: 'active' | 'expired' | 'revoked';
  orgLabel: string;
  maxSessions: number;
  numbers: PairNumberView[];
}

/** `pairing.qr` is either already a data URL or raw base64 PNG. */
function toQrDataUrl(qr: string | undefined): string | undefined {
  if (!qr) return undefined;
  return qr.startsWith('data:') ? qr : `data:image/png;base64,${qr}`;
}

function last4(phoneE164: string | null): string | null {
  return phoneE164 ? phoneE164.slice(-4) : null;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const requestId = mintRequestId(req.headers.get('x-request-id'));

  const ip = getClientIp(req);
  if (!(await checkIp(ip))) {
    return errorResponse(429, ErrorCodes.RATE_LIMITED, 'IP rate limit exceeded', requestId);
  }

  const { token } = await params;
  const invite = await verifyInvite(token);
  if (!invite) {
    // Deliberately identical to "not found", no oracle between a malformed
    // token, an unknown token, and a wrong-but-well-formed token.
    return errorResponse(404, ErrorCodes.NOT_FOUND, 'Invite not found', requestId);
  }

  const org = await getOrg(invite.orgId);
  const orgLabel = org?.label ?? invite.orgId;

  const terminal = (status: 'expired' | 'revoked'): Response =>
    jsonResponse(
      200,
      { status, orgLabel, maxSessions: invite.maxSessions, numbers: [] } satisfies PairViewBody,
      requestId,
    );

  if (invite.status === 'revoked') return terminal('revoked');
  if (invite.status === 'expired' || invite.expiresAt.getTime() <= Date.now()) {
    // Lazy expiry on read; best-effort, the response says 'expired' either way.
    if (invite.status === 'active') markInviteExpired(invite.inviteId).catch(() => {});
    return terminal('expired');
  }

  const numbers: PairNumberView[] = [];
  for (const sessionId of invite.sessionIds) {
    const session = await getSession(sessionId);
    // Deleted out from under the link, drop it from the view rather than
    // rendering a number that no longer exists.
    if (!session) continue;
    const state: PairNumberState =
      session.status === 'connected'
        ? 'connected'
        : session.status === 'pairing' || session.status === 'initialising'
          ? 'pairing'
          : 'offline';
    const qrDataUrl =
      state === 'pairing' ? toQrDataUrl(session.pairing?.qr ?? undefined) : undefined;
    numbers.push({
      sessionId,
      state,
      last4: last4(session.phoneE164),
      ...(qrDataUrl ? { qrDataUrl } : {}),
    });
  }

  return jsonResponse(
    200,
    { status: 'active', orgLabel, maxSessions: invite.maxSessions, numbers } satisfies PairViewBody,
    requestId,
  );
}

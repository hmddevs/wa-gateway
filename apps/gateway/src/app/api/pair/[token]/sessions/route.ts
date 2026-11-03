/**
 * Developed by HMD Developments
 * For HMD WA Gateway
 * www.hmddevs.org
 */
/**
 * POST /api/pair/:token/sessions
 *
 * Public, UNAUTHENTICATED. Adds one number to the organization behind a
 * pairing link: provisions a session, attaches it, and starts pairing so the
 * next status poll returns its QR.
 *
 * This is the endpoint that makes a link reusable. Nothing is provisioned when
 * the link is minted, so an unused link leaves no half-built sessions behind,
 * and a client can add their second and third number without going back to an
 * operator.
 *
 * SECURITY:
 *   - IP rate-limited, same bucket as the status route.
 *   - `verifyInvite` failure 404s identically to an unknown token.
 *   - The `maxSessions` cap is enforced by `recordInviteSession` inside a
 *     single atomic update, so concurrent callers cannot both take the last
 *     slot. The session is provisioned first and rolled back if the cap was
 *     taken in the meantime, leaving a number attached that the link was not
 *     entitled to add would quietly widen who can send as that organization.
 */
import 'server-only';
import { errorResponse, jsonResponse } from '@/lib/http';
import { ErrorCodes } from '@hmddevs/protocol';
import { mintRequestId } from '@/lib/request-id';
import { checkIp } from '@/lib/rate-limit';
import { getClientIp } from '@/lib/auth-api';
import { verifyInvite } from '@/lib/pairing-invite';
import { markInviteExpired, recordInviteSession } from '@/lib/repositories/pairing-invites';
import { provisionOrgNumber } from '@/lib/session-provisioning';
import { deleteSession, invalidateSessionCache } from '@/lib/repositories/sessions';
import { removeSession as removeSessionFromOrg } from '@/lib/repositories/organizations';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
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
    return errorResponse(404, ErrorCodes.NOT_FOUND, 'Invite not found', requestId);
  }

  if (invite.status === 'revoked') {
    return errorResponse(410, ErrorCodes.NOT_FOUND, 'This link has been revoked', requestId);
  }
  if (invite.status === 'expired' || invite.expiresAt.getTime() <= Date.now()) {
    if (invite.status === 'active') markInviteExpired(invite.inviteId).catch(() => {});
    return errorResponse(410, ErrorCodes.NOT_FOUND, 'This link has expired', requestId);
  }
  // Cheap pre-check so a full link does not provision and immediately roll
  // back; `recordInviteSession` is still the authority under concurrency.
  if (invite.sessionIds.length >= invite.maxSessions) {
    return errorResponse(
      409,
      ErrorCodes.INVALID_BODY,
      'This link has already added all the numbers it allows',
      requestId,
    );
  }

  const session = await provisionOrgNumber({
    orgId: invite.orgId,
    workerId: invite.workerId,
    createdBy: `pairing-link:${invite.inviteId}`,
    auditAction: 'pairing_invite.session.create',
    auditMeta: { inviteId: invite.inviteId },
  });

  const recorded = await recordInviteSession(invite.inviteId, session.sessionId);
  if (!recorded) {
    // Lost the race for the last slot. Undo the provisioning so the
    // organization is not left with a number this link could not authorise.
    await removeSessionFromOrg(invite.orgId, session.sessionId).catch(() => {});
    await deleteSession(session.sessionId).catch(() => {});
    invalidateSessionCache(session.sessionId).catch(() => {});
    logger.warn(
      { inviteId: invite.inviteId, sessionId: session.sessionId },
      'pairing link slot lost after provisioning; rolled back',
    );
    return errorResponse(
      409,
      ErrorCodes.INVALID_BODY,
      'This link has already added all the numbers it allows',
      requestId,
    );
  }

  return jsonResponse(
    201,
    { sessionId: session.sessionId, used: recorded.sessionIds.length, max: recorded.maxSessions },
    requestId,
  );
}

/**
 * Admin pairing-link management.
 * GET  /api/admin/pairing-invites, list links (optional ?orgId=)
 * POST /api/admin/pairing-invites, mint a shareable link for an org
 *
 * A link is scoped to an organization and reusable up to `maxSessions`: the
 * client opens it and pairs however many numbers they need, each provisioned
 * and attached to the organization on the spot. No session is created here, * that happens when someone actually scans, so an unused link leaves no
 * half-provisioned sessions behind.
 *
 * POST requires WebAuthn step-up: the link is a bearer credential that lets
 * its holder add numbers to an organization.
 */
import 'server-only';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { requireAdmin } from '@/lib/require-admin';
import { errorResponse, jsonResponse } from '@/lib/http';
import { ErrorCodes, OrgIdSchema } from '@hmddevs/protocol';
import { mintRequestId } from '@/lib/request-id';
import { issueInvite } from '@/lib/pairing-invite';
import {
  insertInvite,
  listInvites,
  type PairingInviteDoc,
} from '@/lib/repositories/pairing-invites';
import { getOrg } from '@/lib/repositories/organizations';
import { env } from '@/lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CreateSchema = z.object({
  orgId: OrgIdSchema,
  label: z.string().min(1).max(128).optional(),
  workerId: z.string().min(1).optional(),
  /** How many numbers this link may add. */
  maxSessions: z.number().int().min(1).max(20).default(5),
  /**
   * Link lifetime. Defaults to 7 days, not the previous hour: these get
   * emailed to a client who scans when they get to it, and an hour meant the
   * link was usually dead before anyone opened it.
   */
  ttlHours: z.number().int().min(1).max(720).default(168),
});

const INVITE_ID_PREFIX = 'pi_';

export async function GET(req: Request): Promise<Response> {
  const requestId = mintRequestId(req.headers.get('x-request-id'));
  const guard = await requireAdmin();
  if (!guard.ok)
    return errorResponse(guard.status, ErrorCodes.UNAUTHORIZED, guard.message, requestId);

  const orgId = new URL(req.url).searchParams.get('orgId') ?? undefined;
  const invites = await listInvites(orgId);
  return jsonResponse(200, { invites }, requestId);
}

export async function POST(req: Request): Promise<Response> {
  const requestId = mintRequestId(req.headers.get('x-request-id'));
  const guard = await requireAdmin({ webauthn: true });
  if (!guard.ok)
    return errorResponse(guard.status, ErrorCodes.UNAUTHORIZED, guard.message, requestId);

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return errorResponse(400, ErrorCodes.INVALID_BODY, 'Invalid JSON', requestId);
  }

  const parsed = CreateSchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(400, ErrorCodes.INVALID_BODY, parsed.error.message, requestId);
  }

  const { orgId, label, maxSessions, ttlHours } = parsed.data;
  const workerId = parsed.data.workerId ?? env.WORKER_ID;

  // Refuse a link to nowhere: a pairing done through it would attach numbers
  // to an organization that does not exist, and the router would never see them.
  const org = await getOrg(orgId);
  if (!org) {
    return errorResponse(404, ErrorCodes.INVALID_BODY, 'Organization not found', requestId);
  }

  const issued = await issueInvite();
  const now = new Date();
  const doc: PairingInviteDoc = {
    inviteId: `${INVITE_ID_PREFIX}${randomUUID().replace(/-/g, '')}`,
    orgId,
    workerId,
    lookupHash: issued.lookupHash,
    tokenHash: issued.tokenHash,
    ...(label ? { label } : {}),
    createdBy: guard.admin.email,
    createdAt: now,
    expiresAt: new Date(now.getTime() + ttlHours * 3_600_000),
    status: 'active',
    maxSessions,
    sessionIds: [],
  };
  // The raw token (`issued.plaintext`) is never persisted, only the two
  // hashes above. It is returned once, below, embedded in the share URL.
  await insertInvite(doc);

  const url = `${env.GATEWAY_PUBLIC_URL}/pair/${issued.plaintext}`;
  return jsonResponse(
    201,
    { url, expiresAt: doc.expiresAt, inviteId: doc.inviteId, maxSessions },
    requestId,
  );
}

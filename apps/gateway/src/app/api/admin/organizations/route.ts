/**
 * Admin organization management.
 * GET  /api/admin/organizations  → list organizations
 * POST /api/admin/organizations  → create an organization (WebAuthn step-up)
 *
 * An organization owns the numbers a key may send from: the router picks a
 * live, healthy, in-budget member at send time. See org-router.
 */
import 'server-only';
import { z } from 'zod';
import { requireAdmin } from '@/lib/require-admin';
import { errorResponse, jsonResponse } from '@/lib/http';
import { ErrorCodes, OrgIdSchema, OrgStrategySchema, SessionIdSchema } from '@hmddevs/protocol';
import { mintRequestId } from '@/lib/request-id';
import { listOrgs, getOrg, upsertOrg } from '@/lib/repositories/organizations';
import { appendAudit } from '@/lib/repositories/audit';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 16 * 1024;

const CreateSchema = z.object({
  orgId: OrgIdSchema,
  label: z.string().min(1).max(128),
  /** Ordered session ids; priority strategy prefers earlier entries. */
  sessions: z.array(SessionIdSchema).max(32).default([]),
  strategy: OrgStrategySchema.default('weighted'),
});

export async function GET(req: Request): Promise<Response> {
  const requestId = mintRequestId(req.headers.get('x-request-id'));
  const guard = await requireAdmin();
  if (!guard.ok)
    return errorResponse(guard.status, ErrorCodes.UNAUTHORIZED, guard.message, requestId);
  const orgs = await listOrgs();
  return jsonResponse(
    200,
    {
      organizations: orgs.map((o) => ({
        orgId: o.orgId,
        label: o.label,
        sessions: o.sessions,
        strategy: o.strategy,
        createdAt: o.createdAt,
      })),
    },
    requestId,
  );
}

export async function POST(req: Request): Promise<Response> {
  const requestId = mintRequestId(req.headers.get('x-request-id'));
  const guard = await requireAdmin({ webauthn: true });
  if (!guard.ok)
    return errorResponse(guard.status, ErrorCodes.UNAUTHORIZED, guard.message, requestId);

  const len = Number(req.headers.get('content-length') ?? 0);
  if (len > MAX_BODY_BYTES) {
    return errorResponse(413, ErrorCodes.PAYLOAD_TOO_LARGE, 'Body too large', requestId);
  }

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

  const existing = await getOrg(parsed.data.orgId);
  if (existing) {
    return errorResponse(409, ErrorCodes.INVALID_BODY, 'Organization already exists', requestId);
  }

  const org = await upsertOrg(parsed.data.orgId, {
    label: parsed.data.label,
    sessions: parsed.data.sessions,
    strategy: parsed.data.strategy,
  });

  await appendAudit({
    actor: { kind: 'admin', id: guard.admin.email, email: guard.admin.email },
    action: 'organization.create',
    target: { kind: 'organization', id: org.orgId },
    meta: { label: org.label, sessions: org.sessions, strategy: org.strategy },
  }).catch((err) => logger.warn({ err: (err as Error).message }, 'audit append failed'));

  return jsonResponse(
    201,
    { orgId: org.orgId, label: org.label, sessions: org.sessions, strategy: org.strategy },
    requestId,
  );
}

/**
 * Admin API key management.
 * POST   /api/admin/keys           → create (returns plaintext ONCE)
 * GET    /api/admin/keys           → list
 * DELETE /api/admin/keys/:id       → revoke
 *
 * Requires WebAuthn step-up.
 */
import 'server-only';
import { z } from 'zod';
import { requireAdmin } from '@/lib/require-admin';
import { errorResponse, jsonResponse } from '@/lib/http';
import { ErrorCodes, ProjectIdSchema } from '@hmddevs/protocol';
import { issueApiKey } from '@/lib/api-key';
import { insertKey, listKeys, type ApiKeyDoc } from '@/lib/repositories/api-keys';
import { appendAudit } from '@/lib/repositories/audit';
import { mintRequestId } from '@/lib/request-id';
import { IpCidrSchema } from './[id]/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CreateSchema = z.object({
  label: z.string().min(1).max(128),
  division: z.string().min(1).max(32),
  env: z.enum(['test', 'live']),
  scopes: z
    .array(
      z.enum([
        'send:notification',
        'send:transactional',
        'send:internal',
        'send:new_recipients',
        'read:status',
        'read:groups',
      ]),
    )
    .min(1),
  rateLimitPerMin: z.number().int().min(1).max(10_000).default(60),
  quotaPerDay: z.number().int().min(1).max(1_000_000).nullable().optional(),
  ipAllowlist: z.array(IpCidrSchema).max(32).optional(),
  webhookUrl: z.string().url().nullable().optional(),
  sessionId: z.string().min(1),
  /**
   * Tenant slug bound to the key at issuance. All messages sent with this key
   * are tagged with this projectId for downstream compliance, retention, and
   * audit categorisation. Lowercase kebab; never sourced from request bodies
   * on the send path, the caller cannot self-declare their project.
   */
  projectId: ProjectIdSchema,
});

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

  const issued = await issueApiKey({ division: parsed.data.division, env: parsed.data.env });
  const doc: ApiKeyDoc = {
    keyId: issued.keyId,
    keyLookupHash: issued.keyLookupHash,
    keyHash: issued.keyHash,
    label: parsed.data.label,
    division: parsed.data.division.toLowerCase(),
    env: parsed.data.env,
    projectId: parsed.data.projectId,
    scopes: parsed.data.scopes,
    rateLimitPerMin: parsed.data.rateLimitPerMin,
    quotaPerDay: parsed.data.quotaPerDay ?? null,
    ipAllowlist: parsed.data.ipAllowlist,
    webhookUrl: parsed.data.webhookUrl ?? null,
    webhookSigningSecret: null,
    sessionId: parsed.data.sessionId,
    createdBy: guard.admin.email,
    createdAt: new Date(),
    revokedAt: null,
  };
  await insertKey(doc);
  await appendAudit({
    actor: { kind: 'admin', id: guard.admin.email, email: guard.admin.email },
    action: 'api_key.create',
    target: { kind: 'api_key', id: doc.keyId },
    meta: { scopes: doc.scopes, env: doc.env, division: doc.division, projectId: doc.projectId },
  });

  return jsonResponse(
    201,
    {
      keyId: issued.keyId,
      plaintext: issued.plaintext, // ONCE, never stored plain
      label: doc.label,
      scopes: doc.scopes,
      env: doc.env,
      division: doc.division,
      projectId: doc.projectId,
      sessionId: doc.sessionId,
    },
    requestId,
  );
}

export async function GET(req: Request): Promise<Response> {
  const requestId = mintRequestId(req.headers.get('x-request-id'));
  const guard = await requireAdmin();
  if (!guard.ok)
    return errorResponse(guard.status, ErrorCodes.UNAUTHORIZED, guard.message, requestId);
  const docs = await listKeys();
  return jsonResponse(
    200,
    {
      keys: docs.map((d) => ({
        keyId: d.keyId,
        label: d.label,
        division: d.division,
        env: d.env,
        projectId: d.projectId,
        scopes: d.scopes,
        rateLimitPerMin: d.rateLimitPerMin,
        quotaPerDay: d.quotaPerDay ?? null,
        ipAllowlist: d.ipAllowlist ?? [],
        sessionId: d.sessionId,
        createdAt: d.createdAt,
        revokedAt: d.revokedAt,
        lastUsedAt: d.lastUsedAt ?? null,
      })),
    },
    requestId,
  );
}

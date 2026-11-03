import 'server-only';
import { requireAdmin } from '@/lib/require-admin';
import { errorResponse, jsonResponse } from '@/lib/http';
import { ErrorCodes } from '@hmddevs/protocol';
import { mintRequestId } from '@/lib/request-id';
import { adminLimiterKey, checkAdminLimit } from '@/lib/admin-rate-limit';
import { verifyAuditChain } from '@/lib/repositories/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const requestId = mintRequestId(req.headers.get('x-request-id'));

  const guard = await requireAdmin();
  if (!guard.ok) {
    return errorResponse(guard.status, ErrorCodes.UNAUTHORIZED, guard.message, requestId);
  }

  // Chain verification iterates every audit entry, gate behind the per-admin
  // limiter to stop accidental or malicious hammering of Mongo/CPU.
  const ok = await checkAdminLimit(adminLimiterKey(guard.admin));
  if (!ok) {
    return errorResponse(429, ErrorCodes.RATE_LIMITED, 'Too many admin requests', requestId);
  }

  const result = await verifyAuditChain();
  return jsonResponse(200, result, requestId);
}

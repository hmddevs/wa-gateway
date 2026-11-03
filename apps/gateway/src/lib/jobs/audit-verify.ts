/**
 * Job: verify the audit hash chain.
 *
 * Extracted from `app/api/cron/audit-verify/route.ts`. Behaviour is unchanged:
 * walk the chain via `verifyAuditChain()` and, on a break, log loudly at error
 * level. Shared by the HTTP cron route and the in-process scheduler.
 */
import 'server-only';
import { verifyAuditChain } from '@/lib/repositories/audit';
import { logger } from '@/lib/logger';

export type AuditVerifyResult = Awaited<ReturnType<typeof verifyAuditChain>>;

export async function runAuditVerify(): Promise<AuditVerifyResult> {
  const result = await verifyAuditChain();
  if (!result.ok) {
    logger.error({ brokenAt: result.brokenAt }, 'AUDIT CHAIN BROKEN');
  }
  return result;
}

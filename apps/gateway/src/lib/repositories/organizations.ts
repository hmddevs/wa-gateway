/**
 * Developed by HMD Developments
 * For HMD WA Gateway
 * www.hmddevs.org
 *
 * Organization repository. One doc per organization in `organizations`.
 *
 * An organization is the unit an API key binds to: it owns a set of member
 * sessions, and the router picks which one sends (see `org-router.ts`). The
 * consumer never names a session and never learns which number sent, so
 * numbers can be attached or detached without touching the caller.
 *
 * Replaces the `session_pools` collection, see docs/ORGANIZATIONS.md and
 * `scripts/migrate-pools-to-orgs.ts`. GATEWAY-ONLY; the worker never sees
 * organizations.
 */
import 'server-only';
import type { Organization } from '@hmddevs/protocol';
import { col } from '../mongo';
import { isOptedOut } from './optouts';
import { setSessionOrg } from './sessions';

/**
 * The stored shape is exactly the protocol contract, `OrganizationSchema` is
 * the single source of truth, so this is an alias rather than a second
 * declaration that could drift from it.
 */
export type OrganizationDoc = Organization;

export async function getOrg(orgId: string): Promise<OrganizationDoc | null> {
  const c = await col<OrganizationDoc>('organizations');
  return c.findOne({ orgId });
}

/**
 * Reverse lookup: the organization a session belongs to, or null when the
 * session is bound directly to a key. Used by the worker callback to normalise
 * an event processed under one member's sessionId back to the organization's
 * canonical head session, so a failover never leaks a different number's id to
 * the customer.
 */
export async function getOrgForSession(sessionId: string): Promise<OrganizationDoc | null> {
  const c = await col<OrganizationDoc>('organizations');
  return c.findOne({ sessions: sessionId });
}

/**
 * Organization-wide opt-out check: a recipient who opted out on ANY member
 * number is suppressed for ALL of them. Without this, routing the next message
 * via a different number silently resurrects a contact who sent STOP, a
 * compliance failure, not a routing inconvenience.
 *
 * Returns false for a missing or empty organization; that case independently
 * fails at the router with `no_sessions`.
 */
export async function isOptedOutAcrossOrg(orgId: string, e164: string): Promise<boolean> {
  const org = await getOrg(orgId);
  if (!org || org.sessions.length === 0) return false;
  const results = await Promise.all(org.sessions.map((sid) => isOptedOut(sid, e164)));
  return results.some(Boolean);
}

export async function listOrgs(): Promise<OrganizationDoc[]> {
  const c = await col<OrganizationDoc>('organizations');
  return c.find({}).sort({ createdAt: -1 }).toArray();
}

/**
 * Insert or replace an organization, keyed on `orgId`. `createdAt` is only set
 * on first insert, so a re-upsert never resets it.
 */
export async function upsertOrg(
  orgId: string,
  patch: Omit<OrganizationDoc, 'orgId' | 'createdAt'>,
): Promise<OrganizationDoc> {
  const c = await col<OrganizationDoc>('organizations');
  await c.updateOne(
    { orgId },
    {
      $set: { orgId, label: patch.label, sessions: patch.sessions, strategy: patch.strategy },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true },
  );
  const doc = await c.findOne({ orgId });
  if (!doc) throw new Error('organization upsert failed');
  return doc;
}

/**
 * Attach a session to the organization (no-op if already a member). This is
 * the whole mid-incident remedy: the next send can pick the new number, with
 * no key change and no deploy.
 */
export async function addSession(
  orgId: string,
  sessionId: string,
): Promise<OrganizationDoc | null> {
  const c = await col<OrganizationDoc>('organizations');
  const r = await c.findOneAndUpdate(
    { orgId },
    { $addToSet: { sessions: sessionId } },
    { returnDocument: 'after' },
  );
  if (r) await setSessionOrg(sessionId, orgId);
  return r ?? null;
}

export async function removeSession(
  orgId: string,
  sessionId: string,
): Promise<OrganizationDoc | null> {
  const c = await col<OrganizationDoc>('organizations');
  const r = await c.findOneAndUpdate(
    { orgId },
    { $pull: { sessions: sessionId } },
    { returnDocument: 'after' },
  );
  if (r) await setSessionOrg(sessionId, null);
  return r ?? null;
}

export async function deleteOrg(orgId: string): Promise<boolean> {
  const c = await col<OrganizationDoc>('organizations');
  const r = await c.deleteOne({ orgId });
  return r.deletedCount === 1;
}

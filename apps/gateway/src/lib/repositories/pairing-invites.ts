/**
 * Pairing-invite repository. One doc per shareable pairing link.
 *
 * A link is scoped to an ORGANIZATION and reusable up to `maxSessions`: the
 * client opens it and adds however many numbers they need, each provisioned
 * and attached to the organization on the spot. It has no 'connected' state, * a link that paired one number is still live for the next.
 *
 * See docs/ORGANIZATIONS.md.
 */
import 'server-only';
import type { ObjectId } from 'mongodb';
import type { PairingInviteDoc as PairingInvite } from '@hmddevs/protocol';
import { col } from '../mongo';

export type PairingInviteDoc = PairingInvite & { _id?: ObjectId };

async function ensureIndexesOnce(): Promise<void> {
  const c = await col<PairingInviteDoc>('pairingInvites');
  await c.createIndexes([
    { key: { inviteId: 1 }, unique: true, name: 'inviteId_unique' },
    { key: { lookupHash: 1 }, unique: true, name: 'lookupHash_unique' },
    { key: { orgId: 1 }, name: 'orgId' },
    { key: { status: 1 }, name: 'status' },
  ]);
}

export async function insertInvite(doc: PairingInviteDoc): Promise<void> {
  await ensureIndexesOnce();
  const c = await col<PairingInviteDoc>('pairingInvites');
  await c.insertOne(doc);
}

export async function findInviteByLookupHash(lookupHash: string): Promise<PairingInviteDoc | null> {
  const c = await col<PairingInviteDoc>('pairingInvites');
  return c.findOne({ lookupHash });
}

export async function findInviteById(inviteId: string): Promise<PairingInviteDoc | null> {
  const c = await col<PairingInviteDoc>('pairingInvites');
  return c.findOne({ inviteId });
}

/**
 * Record a session against a link, enforcing the cap inside the update.
 *
 * `$expr` compares the current array length against `maxSessions`, so two
 * people opening the same link at once cannot both take the last slot.
 * Returns null when the link is not active, has expired, or is already full, * the caller has by then provisioned a session, and must undo it rather than
 * leave a number attached that the link was not entitled to add.
 */
export async function recordInviteSession(
  inviteId: string,
  sessionId: string,
  now: Date = new Date(),
): Promise<PairingInviteDoc | null> {
  const c = await col<PairingInviteDoc>('pairingInvites');
  const r = await c.findOneAndUpdate(
    {
      inviteId,
      status: 'active',
      expiresAt: { $gt: now },
      $expr: { $lt: [{ $size: '$sessionIds' }, '$maxSessions'] },
    },
    { $push: { sessionIds: sessionId } },
    { returnDocument: 'after' },
  );
  return r ?? null;
}

/**
 * Lazily mark a link expired on read. Idempotent no-op once it is no longer
 * active.
 */
export async function markInviteExpired(inviteId: string): Promise<void> {
  const c = await col<PairingInviteDoc>('pairingInvites');
  await c.updateOne({ inviteId, status: 'active' }, { $set: { status: 'expired' } });
}

/**
 * Revoke a link. No-op (returns false) once it is no longer active. Revoking
 * only ever reduces risk, so it is safe behind a plain `requireAdmin()` with
 * no WebAuthn step-up.
 */
export async function revokeInvite(inviteId: string): Promise<boolean> {
  const c = await col<PairingInviteDoc>('pairingInvites');
  const r = await c.updateOne({ inviteId, status: 'active' }, { $set: { status: 'revoked' } });
  return r.modifiedCount === 1;
}

/** Newest first, hashes never projected. `orgId` filters to one organization. */
export async function listInvites(orgId?: string): Promise<PairingInviteDoc[]> {
  const c = await col<PairingInviteDoc>('pairingInvites');
  return c
    .find(orgId ? { orgId } : {}, { projection: { tokenHash: 0, lookupHash: 0 } })
    .sort({ createdAt: -1 })
    .limit(200)
    .toArray();
}

/**
 * API key repository.
 */
import 'server-only';
import type { ObjectId } from 'mongodb';
import type { ProjectId } from '@hmddevs/protocol';
import { col } from '../mongo';
import { issueApiKey } from '../api-key';

export type ApiKeyScope =
  | 'send:notification'
  | 'send:transactional'
  | 'send:internal'
  | 'send:new_recipients'
  | 'read:status'
  | 'read:groups';

export interface ApiKeyDoc {
  _id?: ObjectId;
  keyId: string;
  keyLookupHash: string; // hex
  keyHash: string; // argon2id PHC
  label: string;
  division: string;
  env: 'test' | 'live';
  /**
   * Tenant slug bound at issuance. Every message sent with this key is tagged
   * with this `projectId`, which never comes from request bodies, the caller
   * cannot self-declare which project a send is billed/audited against. Legacy
   * rows issued before the project gate may not carry this field; readers must
   * tolerate `undefined` and fall back to a sentinel where needed.
   */
  projectId: ProjectId;
  scopes: ApiKeyScope[];
  rateLimitPerMin: number;
  quotaPerDay?: number | null;
  ipAllowlist?: string[]; // CIDRs
  webhookUrl?: string | null;
  webhookSigningSecret?: string | null; // base64 32 bytes, per-key
  sessionId: string; // bound session slug
  /**
   * Optional organization binding. When set, the send route asks the router to
   * pick a number from the organization (see `org-router.ts`) instead of using
   * `sessionId`. Absent ⇒ the historical single-session path is unchanged.
   */
  orgId?: string;
  createdBy: string; // admin email
  createdAt: Date;
  lastUsedAt?: Date | null;
  revokedAt?: Date | null;
  usage?: {
    today: { date: string; count: number };
    total: number;
  };
}

export async function findByLookupHash(lookupHash: string): Promise<ApiKeyDoc | null> {
  const c = await col<ApiKeyDoc>('api_keys');
  return c.findOne({ keyLookupHash: lookupHash, revokedAt: null });
}

export async function findById(keyId: string): Promise<ApiKeyDoc | null> {
  const c = await col<ApiKeyDoc>('api_keys');
  return c.findOne({ keyId });
}

export async function listKeys(): Promise<ApiKeyDoc[]> {
  const c = await col<ApiKeyDoc>('api_keys');
  return c
    .find({}, { projection: { keyHash: 0 } })
    .sort({ createdAt: -1 })
    .toArray();
}

/** Active keys bound to a given session, used to fan inbound events to all
 * subscribers of that session. */
export async function listKeysBySession(sessionId: string): Promise<ApiKeyDoc[]> {
  const c = await col<ApiKeyDoc>('api_keys');
  return c
    .find({ sessionId, revokedAt: null }, { projection: { keyHash: 0, keyLookupHash: 0 } })
    .toArray();
}

export async function insertKey(doc: ApiKeyDoc): Promise<void> {
  const c = await col<ApiKeyDoc>('api_keys');
  await c.insertOne(doc);
}

export async function revokeKey(keyId: string): Promise<boolean> {
  const c = await col<ApiKeyDoc>('api_keys');
  const r = await c.updateOne({ keyId, revokedAt: null }, { $set: { revokedAt: new Date() } });
  return r.modifiedCount === 1;
}

/**
 * Patch mutable configuration fields on an active key.
 * Identity fields (scopes, env, division, sessionId) are deliberately not
 * patchable, those are bound at issuance.
 */
export async function updateKey(
  keyId: string,
  patch: {
    ipAllowlist?: string[];
    rateLimitPerMin?: number;
    /** Bind (string) or unbind (null) the key's organization. */
    orgId?: string | null;
  },
): Promise<boolean> {
  const c = await col<ApiKeyDoc>('api_keys');
  const $set: Partial<ApiKeyDoc> = {};
  const $unset: Record<string, ''> = {};
  if (patch.ipAllowlist !== undefined) $set.ipAllowlist = patch.ipAllowlist;
  if (patch.rateLimitPerMin !== undefined) $set.rateLimitPerMin = patch.rateLimitPerMin;
  if (patch.orgId === null) $unset.orgId = '';
  else if (patch.orgId !== undefined) $set.orgId = patch.orgId;
  if (Object.keys($set).length === 0 && Object.keys($unset).length === 0) return false;
  const update: Record<string, unknown> = {};
  if (Object.keys($set).length > 0) update.$set = $set;
  if (Object.keys($unset).length > 0) update.$unset = $unset;
  const r = await c.updateOne({ keyId, revokedAt: null }, update);
  return r.matchedCount === 1;
}

/**
 * Rotate a key's secret material. The public `keyId` handle is preserved so
 * audit references and dashboards stay stable; only `keyLookupHash` and
 * `keyHash` change. The old secret stops authenticating the moment this update
 * commits.
 */
export async function rotateKey(
  keyId: string,
): Promise<{ plaintext: string; keyId: string } | null> {
  const c = await col<ApiKeyDoc>('api_keys');
  const doc = await c.findOne({ keyId, revokedAt: null });
  if (!doc) return null;
  const issued = await issueApiKey({ division: doc.division, env: doc.env });
  const r = await c.updateOne(
    { keyId, revokedAt: null },
    { $set: { keyLookupHash: issued.keyLookupHash, keyHash: issued.keyHash } },
  );
  // Guard against the key being revoked between findOne and updateOne.
  if (r.matchedCount === 0) return null;
  return { plaintext: issued.plaintext, keyId };
}

export async function touchLastUsed(keyId: string): Promise<void> {
  const c = await col<ApiKeyDoc>('api_keys');
  const today = new Date().toISOString().slice(0, 10);
  await c.updateOne(
    { keyId },
    {
      $set: { lastUsedAt: new Date() },
      $inc: { 'usage.total': 1 },
    },
  );
  // Increment today's counter; reset if the date rolled over.
  await c.updateOne(
    { keyId, 'usage.today.date': { $ne: today } },
    { $set: { 'usage.today': { date: today, count: 0 } } },
  );
  await c.updateOne({ keyId }, { $inc: { 'usage.today.count': 1 } });
}

/**
 * Webhook routes, admin-managed delivery destinations.
 *
 * One doc per route. Scope is either an API key or a session; an inbound
 * event fans out to every route bound to its session, an outbound event
 * fans out to every route bound to the originating API key.
 *
 * Secret handling: the raw secret is shown to the admin ONCE on create.
 * It is then stored AES-256-GCM-encrypted at rest (see `webhook-secret-crypto.ts`).
 * The 11-char `secretFingerprint` is the only public identifier of a secret.
 */
import 'server-only';
import { randomBytes, randomUUID } from 'node:crypto';
import type { ObjectId } from 'mongodb';
import type { WebhookEventType } from '@hmddevs/protocol';
import { col } from '../mongo';
import { sealSecret, type SealedSecret } from '../webhook-secret-crypto';

export type WebhookRouteScope =
  | { kind: 'apiKey'; apiKeyId: string }
  | { kind: 'session'; sessionId: string };

export interface WebhookRouteDoc {
  _id?: ObjectId;
  routeId: string;
  scope: WebhookRouteScope;
  url: string;
  /** Encrypted raw secret. Stored as separate fields for `mongosh` clarity. */
  secretCiphertext: string;
  secretIv: string;
  secretAuthTag: string;
  /** First 8 bytes of secret as base64url (11 chars), UI display only. */
  secretFingerprint: string;
  events: WebhookEventType[];
  active: boolean;
  description: string | null;
  createdAt: Date;
  createdBy: string;
  lastDeliveryAt: Date | null;
  lastDeliveryStatus: 'sent' | 'failed' | null;
  lastDeliveryHttpStatus: number | null;
  revokedAt: Date | null;
}

/** Fields safe to return to admins; omits secret ciphertext/IV/auth tag. */
export function publicView(doc: WebhookRouteDoc) {
  return {
    routeId: doc.routeId,
    scope: doc.scope,
    url: doc.url,
    events: doc.events,
    active: doc.active,
    description: doc.description,
    secretFingerprint: doc.secretFingerprint,
    createdAt: doc.createdAt,
    createdBy: doc.createdBy,
    lastDeliveryAt: doc.lastDeliveryAt,
    lastDeliveryStatus: doc.lastDeliveryStatus,
    lastDeliveryHttpStatus: doc.lastDeliveryHttpStatus,
    revokedAt: doc.revokedAt,
  };
}

export interface CreateRouteInput {
  scope: WebhookRouteScope;
  url: string;
  events: WebhookEventType[];
  description?: string | null;
  createdBy: string;
}

export interface CreateRouteResult {
  route: WebhookRouteDoc;
  /** Raw base64url 32-byte secret. Returned ONCE; never persisted. */
  secret: string;
}

const ROUTE_ID_PREFIX = 'whr_';

function fingerprintFromSecret(secretBytes: Buffer): string {
  // First 8 bytes → 11-char base64url (no padding).
  return secretBytes.subarray(0, 8).toString('base64url');
}

async function ensureIndexesOnce(): Promise<void> {
  const c = await col<WebhookRouteDoc>('webhook_routes');
  await c.createIndexes([
    { key: { routeId: 1 }, unique: true, name: 'routeId_unique' },
    { key: { 'scope.apiKeyId': 1 }, sparse: true, name: 'scope_apiKey' },
    { key: { 'scope.sessionId': 1 }, sparse: true, name: 'scope_session' },
    { key: { active: 1 }, name: 'active' },
  ]);
}

export async function createRoute(input: CreateRouteInput): Promise<CreateRouteResult> {
  await ensureIndexesOnce();
  const c = await col<WebhookRouteDoc>('webhook_routes');

  const secretBytes = randomBytes(32);
  const secret = secretBytes.toString('base64url');
  const sealed: SealedSecret = sealSecret(secret);

  const doc: WebhookRouteDoc = {
    routeId: `${ROUTE_ID_PREFIX}${randomUUID().replace(/-/g, '').slice(0, 24)}`,
    scope: input.scope,
    url: input.url,
    secretCiphertext: sealed.ciphertext,
    secretIv: sealed.iv,
    secretAuthTag: sealed.authTag,
    secretFingerprint: fingerprintFromSecret(secretBytes),
    events: input.events,
    active: true,
    description: input.description ?? null,
    createdAt: new Date(),
    createdBy: input.createdBy,
    lastDeliveryAt: null,
    lastDeliveryStatus: null,
    lastDeliveryHttpStatus: null,
    revokedAt: null,
  };
  await c.insertOne(doc);
  return { route: doc, secret };
}

export async function getRoute(routeId: string): Promise<WebhookRouteDoc | null> {
  const c = await col<WebhookRouteDoc>('webhook_routes');
  return c.findOne({ routeId });
}

export async function listRoutes(filter: {
  apiKeyId?: string;
  sessionId?: string;
  includeRevoked?: boolean;
}): Promise<WebhookRouteDoc[]> {
  const c = await col<WebhookRouteDoc>('webhook_routes');
  const q: Record<string, unknown> = {};
  if (filter.apiKeyId) q['scope.apiKeyId'] = filter.apiKeyId;
  if (filter.sessionId) q['scope.sessionId'] = filter.sessionId;
  if (!filter.includeRevoked) q.revokedAt = null;
  return c.find(q).sort({ createdAt: -1 }).toArray();
}

/**
 * Look up routes whose scope matches and whose `events[]` contains `eventType`.
 * Pass `apiKeyIds` AND/OR `sessionIds` to fan out across multiple scopes in
 * one query (the typical dispatch path: an inbound message must reach every
 * route bound to its session OR to any API key bound to that session).
 */
export async function findMatchingRoutes(params: {
  eventType: WebhookEventType;
  apiKeyIds?: string[];
  sessionIds?: string[];
}): Promise<WebhookRouteDoc[]> {
  const c = await col<WebhookRouteDoc>('webhook_routes');
  const or: Record<string, unknown>[] = [];
  if (params.apiKeyIds && params.apiKeyIds.length > 0) {
    or.push({ 'scope.apiKeyId': { $in: params.apiKeyIds } });
  }
  if (params.sessionIds && params.sessionIds.length > 0) {
    or.push({ 'scope.sessionId': { $in: params.sessionIds } });
  }
  if (or.length === 0) return [];
  return c
    .find({
      active: true,
      revokedAt: null,
      events: params.eventType,
      $or: or,
    })
    .toArray();
}

export interface UpdateRoutePatch {
  url?: string;
  events?: WebhookEventType[];
  active?: boolean;
  description?: string | null;
}

export async function updateRoute(
  routeId: string,
  patch: UpdateRoutePatch,
): Promise<WebhookRouteDoc | null> {
  const c = await col<WebhookRouteDoc>('webhook_routes');
  const set: Record<string, unknown> = {};
  if (patch.url !== undefined) set.url = patch.url;
  if (patch.events !== undefined) set.events = patch.events;
  if (patch.active !== undefined) set.active = patch.active;
  if (patch.description !== undefined) set.description = patch.description;
  if (Object.keys(set).length === 0) return c.findOne({ routeId });
  await c.updateOne({ routeId, revokedAt: null }, { $set: set });
  return c.findOne({ routeId });
}

export async function revokeRoute(routeId: string, _by: string): Promise<boolean> {
  const c = await col<WebhookRouteDoc>('webhook_routes');
  const r = await c.updateOne(
    { routeId, revokedAt: null },
    { $set: { revokedAt: new Date(), active: false } },
  );
  return r.modifiedCount === 1;
}

export async function recordDeliveryOutcome(
  routeId: string,
  outcome: { status: 'sent' | 'failed'; httpStatus: number | null; at: Date },
): Promise<void> {
  const c = await col<WebhookRouteDoc>('webhook_routes');
  await c.updateOne(
    { routeId },
    {
      $set: {
        lastDeliveryAt: outcome.at,
        lastDeliveryStatus: outcome.status,
        lastDeliveryHttpStatus: outcome.httpStatus,
      },
    },
  );
}

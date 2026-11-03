/**
 * MongoDB client (singleton, cached across hot-reloads in dev).
 * Connection string and database come from env. First connection ensures
 * all indexes exist (idempotent, Mongo skips equivalent indexes).
 */
import 'server-only';
import {
  MongoClient,
  type AnyBulkWriteOperation,
  type Db,
  type Collection,
  type Document,
} from 'mongodb';
import type {
  ChatContactDoc,
  ChatEventDoc,
  ContactDoc,
  GroupDoc,
  MessageReactionDoc,
  MessageRevisionDoc,
} from '@hmddevs/protocol';
import type { InboundMessageDoc } from './repositories/inbound-messages';
import { jidToE164 } from './phone';
import { getRedis } from './redis';
import { env } from './env';

declare global {
  // eslint-disable-next-line no-var
  var __hmdMongo: { client: MongoClient; db: Db; ensured: boolean } | undefined;
}

async function createClient(): Promise<{ client: MongoClient; db: Db }> {
  const client = new MongoClient(env.MONGODB_URI, {
    appName: 'hmd-wa-gateway',
    // Persistent process (not serverless) fronting up to ~250 in-flight
    // requests, so we hold a warm pool to Atlas to avoid checkout queueing.
    maxPoolSize: 75,
    minPoolSize: 5,
    serverSelectionTimeoutMS: 8_000,
    socketTimeoutMS: 30_000,
    retryWrites: true,
  });
  await client.connect();
  const db = client.db(env.MONGODB_DB);
  return { client, db };
}

/**
 * Shared-tier retention bound: message/inbound/chat-event rows self-expire 90
 * days after their canonical date field. Re-added after the 2026-05-10 removal
 * to cap storage on the shared cluster. NEVER applied to `audit_log`, that is
 * an append-only hash chain and pruning would break verification.
 */
export const RETENTION_TTL_SECONDS = 90 * 24 * 60 * 60;

/**
 * A TTL index can only be (re)declared via `createIndexes` when no index with
 * the same key spec already exists; Mongo rejects a conflicting redefinition
 * (`IndexOptionsConflict`) otherwise. Several collections already carry a
 * non-TTL index on the retention key (e.g. `messages.ttl_90d`, created without
 * `expireAfterSeconds` after the 2026-05-10 removal). Bring those up to a TTL
 * index idempotently: if an index on the exact key exists, `collMod` sets
 * `expireAfterSeconds` in place; otherwise create it fresh.
 *
 * Idempotent and safe on every boot: a no-op once the TTL is already set.
 */
export async function ensureRetentionTtl(
  db: Db,
  collection: string,
  keyField: string,
  direction: 1 | -1,
  indexName: string,
): Promise<void> {
  const coll = db.collection(collection);
  const existing = (await coll.indexes()) as Array<{
    name?: string;
    key?: Record<string, number>;
    expireAfterSeconds?: number;
  }>;
  const match = existing.find(
    (ix) => ix.key && ix.key[keyField] === direction && Object.keys(ix.key).length === 1,
  );

  if (!match) {
    await coll.createIndexes([
      {
        key: { [keyField]: direction },
        expireAfterSeconds: RETENTION_TTL_SECONDS,
        name: indexName,
      },
    ]);
    return;
  }

  if (match.expireAfterSeconds === RETENTION_TTL_SECONDS) return;

  // Index exists on the key but with no / a different TTL, patch it in place.
  await db.command({
    collMod: collection,
    index: { name: match.name, expireAfterSeconds: RETENTION_TTL_SECONDS },
  });
}

async function ensureIndexes(db: Db): Promise<void> {
  await Promise.all([
    db.collection('api_keys').createIndexes([
      { key: { keyLookupHash: 1 }, unique: true, name: 'keyLookupHash_unique' },
      { key: { keyId: 1 }, unique: true, name: 'keyId_unique' },
      { key: { division: 1 }, name: 'division' },
      { key: { revokedAt: 1 }, name: 'revokedAt', sparse: true },
    ]),
    db.collection('messages').createIndexes([
      { key: { messageId: 1 }, unique: true, name: 'messageId_unique' },
      { key: { apiKeyId: 1, createdAt: -1 }, name: 'apiKeyId_createdAt' },
      { key: { sessionId: 1, to: 1, createdAt: -1 }, name: 'session_to_createdAt' },
      { key: { status: 1, ttlExpiresAt: 1 }, name: 'status_ttl' },
      { key: { status: 1, scheduledFor: 1 }, name: 'status_scheduledFor', sparse: true },
      { key: { waMessageId: 1 }, sparse: true, name: 'waMessageId' },
      {
        key: { idempotencyKey: 1, apiKeyId: 1 },
        unique: true,
        // why: partial replaces the old sparse definition, sparse on a compound
        // index only omits documents where ALL fields are absent; since apiKeyId
        // is always present, every doc was indexed including null-key ones, causing
        // E11000 on any second send without an idempotency key. The partial filter
        // restricts indexing to real string keys only.
        partialFilterExpression: { idempotencyKey: { $type: 'string' } },
        name: 'idempotency_unique',
      },
      {
        key: { createdAt: 1 },
        // why: TTL removed 2026-05-10; migration script handles existing clusters
        name: 'ttl_90d',
      },
    ]),
    db.collection('audit_log').createIndexes([
      { key: { seq: 1 }, unique: true, name: 'seq_unique' },
      { key: { at: -1 }, name: 'at_desc' },
      { key: { 'actor.id': 1, at: -1 }, name: 'actor_at' },
      { key: { action: 1, at: -1 }, name: 'action_at' },
    ]),
    db.collection('admin_sessions').createIndexes([
      { key: { sessionId: 1 }, unique: true, name: 'sessionId_unique' },
      { key: { email: 1 }, name: 'email' },
      { key: { expiresAt: 1 }, expireAfterSeconds: 0, name: 'ttl_expires' },
    ]),
    db.collection('webauthn_credentials').createIndexes([
      { key: { credentialId: 1 }, unique: true, name: 'credentialId_unique' },
      { key: { email: 1 }, name: 'email' },
    ]),
    db.collection('inbound_messages').createIndexes([
      { key: { waMessageId: 1 }, unique: true, name: 'waMessageId_unique' },
      { key: { fromHash: 1, at: -1 }, name: 'fromHash_at' },
      { key: { at: -1 }, name: 'at_desc' },
      { key: { sessionId: 1, from: 1, receivedAt: -1 }, name: 'session_from_receivedAt' },
      { key: { sessionId: 1, receivedAt: -1 }, name: 'session_receivedAt' },
      {
        key: { sessionId: 1, fromE164: 1, receivedAt: -1 },
        name: 'inbound_session_fromE164_receivedAt',
      },
    ]),
    db
      .collection('inbound_routes')
      .createIndexes([{ key: { enabled: 1, priority: -1 }, name: 'active_priority' }]),
    db.collection('counters').createIndexes([{ key: { _id: 1 }, name: '_id_' }]),
    db.collection('opt_outs').createIndexes([
      { key: { sessionId: 1, phone: 1 }, unique: true, name: 'sessionId_phone_unique' },
      { key: { sessionId: 1, createdAt: -1 }, name: 'sessionId_createdAt' },
    ]),
    db.collection('consents').createIndexes([
      {
        key: { sessionId: 1, phone: 1, basis: 1 },
        unique: true,
        name: 'sessionId_phone_basis_unique',
      },
      { key: { sessionId: 1, phone: 1 }, name: 'sessionId_phone' },
    ]),
    db.collection('chat_events').createIndexes([
      {
        key: { sessionId: 1, waMessageId: 1 },
        unique: true,
        name: 'chat_events_session_wamid_unique',
      },
      {
        key: { sessionId: 1, counterpartyE164: 1, ts: -1 },
        name: 'chat_events_session_e164_ts',
      },
      { key: { sessionId: 1, ts: -1 }, name: 'chat_events_session_ts' },
      // why: TTL removed 2026-05-10; migration script handles existing clusters
      { key: { ts: 1 }, name: 'chat_events_ttl' },
    ]),
    db.collection('chat_contacts').createIndexes([
      {
        key: { sessionId: 1, jid: 1 },
        unique: true,
        name: 'chat_contacts_session_jid_unique',
      },
    ]),
    db.collection('sessions').createIndexes([
      { key: { sessionId: 1 }, unique: true, name: 'sessions_sessionId_unique' },
      { key: { workerId: 1 }, name: 'sessions_workerId' },
      { key: { orgId: 1 }, sparse: true, name: 'sessions_orgId' },
    ]),
    db.collection('organizations').createIndexes([
      { key: { orgId: 1 }, unique: true, name: 'organizations_orgId_unique' },
      // Reverse lookup on every worker callback (`getOrgForSession`), so it
      // is on the hot inbound path, not just admin reads.
      { key: { sessions: 1 }, name: 'organizations_sessions' },
    ]),
    db.collection('message_revisions').createIndexes([
      // why: append-only dedup key. Holds even when `messageId` is null on
      // first insert (revision arrived before original); reconciliation
      // happens via the `(sessionId, waMessageId, revisionSeq)` index below.
      {
        key: { sessionId: 1, messageId: 1, revisionSeq: 1 },
        unique: true,
        sparse: true,
        name: 'message_revisions_session_messageId_seq_unique',
      },
      // why: lookup path before resolving messageId on insert, AND the
      // viewer aggregation $lookup keys when joining revisions onto the
      // unioned message stream.
      {
        key: { sessionId: 1, waMessageId: 1, revisionSeq: 1 },
        name: 'message_revisions_session_waMessageId_seq',
      },
      { key: { sessionId: 1, ts: -1 }, name: 'message_revisions_session_ts' },
    ]),
    db.collection('contacts').createIndexes([
      { key: { sessionId: 1, e164: 1 }, unique: true, name: 'contacts_session_e164_unique' },
      { key: { sessionId: 1, waJid: 1 }, name: 'contacts_session_waJid' },
    ]),
    db.collection('message_reactions').createIndexes([
      // why: replace-on-conflict key, one row per peer per target message;
      // the latest reaction (or cleared empty-string) overwrites in place.
      {
        key: { sessionId: 1, waMessageId: 1, fromJid: 1 },
        unique: true,
        name: 'message_reactions_session_wamid_fromJid_unique',
      },
      // Lookup-by-message for the viewer aggregation $lookup.
      {
        key: { sessionId: 1, waMessageId: 1 },
        name: 'message_reactions_session_waMessageId',
      },
      // Time scans (audit / reporting).
      {
        key: { sessionId: 1, ts: -1 },
        name: 'message_reactions_session_ts',
      },
    ]),
    db.collection('groups').createIndexes([
      // why: replace-on-conflict upsert key, one row per group per session,
      // the latest fetch always wins (see GroupDocSchema).
      {
        key: { sessionId: 1, jid: 1 },
        unique: true,
        name: 'groups_session_jid_unique',
      },
    ]),
  ]);

  // Retention TTL (90d) on the shared-tier write collections. Run after the
  // base indexes exist so `collMod` can patch the existing non-TTL index in
  // place. `audit_log` is deliberately excluded (append-only hash chain).
  await ensureRetentionTtl(db, 'messages', 'createdAt', 1, 'ttl_90d');
  await ensureRetentionTtl(db, 'inbound_messages', 'at', -1, 'at_desc');
  await ensureRetentionTtl(db, 'chat_events', 'ts', 1, 'chat_events_ttl');
}

const INBOUND_E164_BACKFILL_MARKER = 'wa:migration:inbound-e164-backfill:done';

/**
 * One-shot backfill: pre-existing `inbound_messages` rows store `from` as a
 * raw Baileys JID; the new `fromE164` field is what the admin viewer
 * aggregation reads. Set `fromE164` on any rows missing it by extracting
 * digits from the JID.
 *
 * Gated behind a one-time Redis marker so it stops re-running the full
 * `find({ fromE164: { $exists: false } })` collection scan on every boot once
 * drained. The marker is only set after a pass confirms zero rows remain, so
 * correctness holds: if any work is left (or the marker store is unavailable),
 * the scan runs again next boot. Marker read/write failures are non-fatal, * Mongo boot must not hard-depend on Redis.
 */
async function backfillInboundFromE164(db: Db): Promise<void> {
  let redis: ReturnType<typeof getRedis> | undefined;
  try {
    redis = getRedis();
    if ((await redis.get(INBOUND_E164_BACKFILL_MARKER)) !== null) {
      // Already drained on a previous boot, skip the full collection scan.
      return;
    }
  } catch (err) {
    // Marker unavailable: fall through and run the (idempotent) backfill.
    // eslint-disable-next-line no-console
    console.error(
      { err: (err as Error).message },
      '[backfill] marker read failed; running backfill anyway',
    );
    redis = undefined;
  }

  const inbound = db.collection<InboundMessageDoc>('inbound_messages');
  const cursor = inbound.find(
    { fromE164: { $exists: false } },
    { projection: { _id: 1, from: 1 } },
  );
  const ops: AnyBulkWriteOperation<InboundMessageDoc>[] = [];
  for await (const doc of cursor) {
    const fromE164 = jidToE164(doc.from);
    ops.push({
      updateOne: {
        filter: { _id: doc._id },
        update: { $set: { fromE164 } },
      },
    });
    if (ops.length >= 500) {
      await inbound.bulkWrite(ops, { ordered: false });
      ops.length = 0;
    }
  }
  if (ops.length > 0) {
    await inbound.bulkWrite(ops, { ordered: false });
  }

  // Only claim "done" once the collection is fully drained. A concurrent
  // inserter could in theory add an un-backfilled row between the scan and
  // this check, but new inbound writes always set `fromE164` at insert time,
  // so anything still missing it would be pre-existing legacy data.
  const remaining = await inbound.countDocuments({ fromE164: { $exists: false } }, { limit: 1 });
  if (remaining === 0 && redis) {
    try {
      await redis.set(INBOUND_E164_BACKFILL_MARKER, new Date().toISOString());
    } catch (err) {
      // Non-fatal: we simply re-scan (a no-op) on the next boot.
      // eslint-disable-next-line no-console
      console.error(
        { err: (err as Error).message },
        '[backfill] marker write failed; will re-scan next boot',
      );
    }
  }
}

export async function getMongo(): Promise<{ client: MongoClient; db: Db }> {
  if (global.__hmdMongo) {
    return { client: global.__hmdMongo.client, db: global.__hmdMongo.db };
  }
  const { client, db } = await createClient();
  global.__hmdMongo = { client, db, ensured: false };
  if (!global.__hmdMongo.ensured) {
    await ensureIndexes(db);
    await backfillInboundFromE164(db);
    global.__hmdMongo.ensured = true;
  }
  return { client, db };
}

export async function col<T extends Document = Document>(name: string): Promise<Collection<T>> {
  const { db } = await getMongo();
  return db.collection<T>(name);
}

export async function chatEvents(): Promise<Collection<ChatEventDoc>> {
  const { db } = await getMongo();
  return db.collection<ChatEventDoc>('chat_events');
}

export async function chatContacts(): Promise<Collection<ChatContactDoc>> {
  const { db } = await getMongo();
  return db.collection<ChatContactDoc>('chat_contacts');
}

export async function messageRevisions(): Promise<Collection<MessageRevisionDoc>> {
  const { db } = await getMongo();
  return db.collection<MessageRevisionDoc>('message_revisions');
}

export async function contacts(): Promise<Collection<ContactDoc>> {
  const { db } = await getMongo();
  return db.collection<ContactDoc>('contacts');
}

export async function messageReactions(): Promise<Collection<MessageReactionDoc>> {
  const { db } = await getMongo();
  return db.collection<MessageReactionDoc>('message_reactions');
}

export async function groups(): Promise<Collection<GroupDoc>> {
  const { db } = await getMongo();
  return db.collection<GroupDoc>('groups');
}

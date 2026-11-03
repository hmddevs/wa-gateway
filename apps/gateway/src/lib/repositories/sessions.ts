/**
 * Session repository. One doc per (sessionId, workerId) pair.
 * A session represents a single Baileys WhatsApp session on a given worker.
 *
 * Reads: getCachedSession() returns a 5s TTL cached read from an in-process
 * cache (see memory-cache.ts, single-instance assumption).
 * Mutations: invalidateSessionCache() deletes the cache entry on writes.
 */
import 'server-only';
import type { ObjectId } from 'mongodb';
import { col } from '../mongo';
import { TtlCache } from '../memory-cache';

export interface SessionConversationConfig {
  sendReadReceipts: boolean;
  /** Inbound text keywords (case-insensitive) that trigger an automatic
   *  opt-out for the sender. Empty/undefined ⇒ default ['STOP']. */
  optOutKeywords?: string[];
  /** Whether the worker requests Baileys' full chat-archive history sync on
   *  pair. Defaults to false at the schema layer. Set true for sessions that
   *  genuinely need chat history (inbound triage, analytics); accept the
   *  reboot-fragility trade-off. See PR #71 / #74. */
  syncFullHistory?: boolean;
}

export interface SessionDoc {
  _id?: ObjectId;
  sessionId: string; // slug e.g. "session-a"
  workerId: string;
  label: string;
  status: 'initialising' | 'pairing' | 'connected' | 'degraded' | 'offline' | 'stopped';
  phoneE164: string | null;
  pairing: { event: 'qr' | 'paired' | 'logged_out'; qr?: string; at: Date } | null;
  version: string | null;
  lastHeartbeatAt: Date | null;
  connectedAt: Date | null;
  createdBy: string;
  createdAt: Date;
  stoppedAt: Date | null;
  /** Conversational behaviour toggles. Absent on legacy docs, readers
   *  back-fill defaults via `getConversationConfig`. */
  conversation?: SessionConversationConfig;
  /** Pre-pair history-sync progress from the most recent heartbeat.
   *  Null or absent means no sync in progress or sync complete. */
  historySyncProgress?: { received: number; isLatest: boolean } | null;
  /** Outbound Redis subscription health from the most recent heartbeat, true
   *  when the worker is connected AND listening for sends. Absent on legacy
   *  docs and on heartbeats from a worker that predates the field. */
  subscribed?: boolean;
  /** Organization this number routes for. Absent on sessions bound directly
   *  to an API key, which keep the historical single-session path. */
  orgId?: string;
  /** Per-number send caps. Absent ⇒ `DEFAULT_BUDGET` in session-state.ts. */
  budget?: { perMinute: number; perHour: number; perDay: number };
  /** First-pair timestamp, driving the warm-up ramp. Absent ⇒ fully warmed,
   *  so numbers already in production are not retroactively throttled. */
  warmupStartedAt?: Date;
  /** Admin kill-switch. A paused session is skipped by the router but stays
   *  connected and keeps receiving inbound. */
  paused?: boolean;
}

export async function upsertSession(
  sessionId: string,
  patch: Partial<SessionDoc>,
): Promise<SessionDoc> {
  const c = await col<SessionDoc>('sessions');
  await c.updateOne({ sessionId }, { $set: { sessionId, ...patch } }, { upsert: true });
  const doc = await c.findOne({ sessionId });
  if (!doc) throw new Error('session upsert failed');
  return doc;
}

export async function getSession(sessionId: string): Promise<SessionDoc | null> {
  const c = await col<SessionDoc>('sessions');
  return c.findOne({ sessionId });
}

export async function listSessions(): Promise<SessionDoc[]> {
  const c = await col<SessionDoc>('sessions');
  return c.find({}).sort({ createdAt: -1 }).toArray();
}

export async function listSessionsByWorker(workerId: string): Promise<SessionDoc[]> {
  const c = await col<SessionDoc>('sessions');
  return c.find({ workerId }).sort({ createdAt: -1 }).toArray();
}

/**
 * Update an existing session. No-op (returns null) when the session does not
 * exist, prevents deleted sessions from being re-inserted by worker callbacks.
 */
export async function updateSession(
  sessionId: string,
  patch: Partial<SessionDoc>,
): Promise<SessionDoc | null> {
  const c = await col<SessionDoc>('sessions');
  const r = await c.findOneAndUpdate({ sessionId }, { $set: patch }, { returnDocument: 'after' });
  return r ?? null;
}

export async function deleteSession(sessionId: string): Promise<boolean> {
  const c = await col<SessionDoc>('sessions');
  const r = await c.deleteOne({ sessionId });
  return r.deletedCount === 1;
}

/**
 * Patch the routing config for a session: its per-number send budget and the
 * admin pause switch. Both feed `org-router.ts`; neither has any effect on a
 * session that is not a member of an organization.
 */
export async function updateRoutingConfig(
  sessionId: string,
  patch: { paused?: boolean; budget?: { perMinute: number; perHour: number; perDay: number } },
): Promise<SessionDoc | null> {
  const set: Record<string, unknown> = {};
  if (typeof patch.paused === 'boolean') set.paused = patch.paused;
  if (patch.budget) set.budget = patch.budget;
  if (Object.keys(set).length === 0) return getSession(sessionId);
  const c = await col<SessionDoc>('sessions');
  const r = await c.findOneAndUpdate({ sessionId }, { $set: set }, { returnDocument: 'after' });
  return r ?? null;
}

/**
 * Point a session at an organization, or clear it with `null`.
 *
 * Kept in step with the organization's own `sessions` array by
 * `organizations.ts`, the array is what the router reads, but a session whose
 * `orgId` disagreed with it would make the `sessions_orgId` index lie and the
 * admin's "unattached sessions" picker offer numbers that are already in use.
 */
export async function setSessionOrg(sessionId: string, orgId: string | null): Promise<void> {
  const c = await col<SessionDoc>('sessions');
  await c.updateOne(
    { sessionId },
    orgId === null ? { $unset: { orgId: '' } } : { $set: { orgId } },
  );
  invalidateSessionCache(sessionId).catch(() => {});
}

/**
 * Stamp the moment a number first completed pairing, which starts its warm-up
 * ramp. Guarded on absence so a re-pair (or a reconnect that replays `paired`)
 * never restarts the ramp and silently throttles an established number back to
 * 10%.
 */
export async function markWarmupStarted(sessionId: string, at: Date): Promise<void> {
  const c = await col<SessionDoc>('sessions');
  await c.updateOne(
    { sessionId, warmupStartedAt: { $exists: false } },
    { $set: { warmupStartedAt: at } },
  );
}

/**
 * Patch the conversation config for a session. Only the fields present in
 * `patch` are written; unknown keys are ignored by Mongo's `$set` semantics.
 * Returns the updated doc, or null when the session does not exist.
 */
export async function updateConversationConfig(
  sessionId: string,
  patch: {
    sendReadReceipts?: boolean;
    optOutKeywords?: string[];
    syncFullHistory?: boolean;
  },
): Promise<SessionDoc | null> {
  const c = await col<SessionDoc>('sessions');
  const set: Record<string, unknown> = {};
  if (typeof patch.sendReadReceipts === 'boolean') {
    set['conversation.sendReadReceipts'] = patch.sendReadReceipts;
  }
  if (Array.isArray(patch.optOutKeywords)) {
    set['conversation.optOutKeywords'] = patch.optOutKeywords;
  }
  if (typeof patch.syncFullHistory === 'boolean') {
    set['conversation.syncFullHistory'] = patch.syncFullHistory;
  }
  if (Object.keys(set).length === 0) {
    return c.findOne({ sessionId });
  }
  const r = await c.findOneAndUpdate({ sessionId }, { $set: set }, { returnDocument: 'after' });
  return r ?? null;
}

/**
 * Read the effective conversation config for a session. Defaults to
 * `sendReadReceipts: true` when the field is missing on the doc, preserves
 * legacy behaviour on sessions provisioned before the toggle existed.
 * Returns null when the sessionId does not exist.
 */
export async function getConversationConfig(
  sessionId: string,
): Promise<SessionConversationConfig | null> {
  const c = await col<SessionDoc>('sessions');
  const doc = await c.findOne({ sessionId }, { projection: { conversation: 1 } });
  if (!doc) return null;
  return {
    sendReadReceipts: doc.conversation?.sendReadReceipts ?? true,
    optOutKeywords: doc.conversation?.optOutKeywords,
    syncFullHistory: doc.conversation?.syncFullHistory ?? false,
  };
}

/** Process-local 5s TTL cache. See memory-cache.ts for the single-instance
 *  assumption this relies on. */
const sessionCache = new TtlCache<SessionDoc>(5000);

/**
 * Cached session read with a 5s in-process TTL. Keeps the hot send/presence
 * path off Mongo without a network round-trip to a shared cache.
 */
export async function getCachedSession(sessionId: string): Promise<SessionDoc | null> {
  const cached = sessionCache.get(sessionId);
  if (cached !== undefined) return cached;

  const doc = await getSession(sessionId);
  if (!doc) return null;

  sessionCache.set(sessionId, doc);
  return doc;
}

/** Invalidate the session cache entry. Called write-through on session writes. */
export async function invalidateSessionCache(sessionId: string): Promise<void> {
  sessionCache.del(sessionId);
}

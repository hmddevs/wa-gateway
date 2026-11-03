/**
 * Chat contacts repository, upserts peer contact records synced from Baileys'
 * `contacts.set` event during full-history capture. Each (sessionId, jid) pair
 * is a single document; subsequent upserts fully replace all mutable fields.
 */
import 'server-only';
import type { ChatContactDoc } from '@hmddevs/protocol';
import { chatContacts } from '../mongo';

/**
 * Single-contact upsert. Retained for any future single-event callers; the
 * batch-ingestion path uses `bulkUpsertChatContacts` to avoid 500 sequential
 * round-trips per batch.
 */
export async function upsertChatContact(input: ChatContactDoc): Promise<void> {
  const { sessionId, jid, ...rest } = input;
  const c = await chatContacts();
  await c.updateOne(
    { sessionId, jid },
    { $set: { ...rest, updatedAt: new Date() } },
    { upsert: true },
  );
}

/**
 * Bulk upsert for the history-sync batch endpoint. Uses `bulkWrite` with
 * `ordered: false` so a single write failure doesn't abort the rest of the
 * batch. Replaces the previous per-item `await` loop, which serialised 500
 * round-trips per batch and tripped Vercel's request timeout under typical
 * Atlas latency.
 *
 * Returns inserted vs modified counts so the caller can surface idempotency
 * outcomes; callers that don't care can ignore the return shape.
 */
export async function bulkUpsertChatContacts(
  sessionId: string,
  contacts: Array<Omit<ChatContactDoc, 'sessionId' | 'updatedAt'>>,
): Promise<{ upserted: number; modified: number }> {
  if (contacts.length === 0) return { upserted: 0, modified: 0 };
  const coll = await chatContacts();
  const now = new Date();
  const r = await coll.bulkWrite(
    contacts.map((c) => ({
      updateOne: {
        filter: { sessionId, jid: c.jid },
        update: {
          $set: {
            sessionId,
            jid: c.jid,
            e164: c.e164,
            pushName: c.pushName,
            notify: c.notify,
            verifiedName: c.verifiedName,
            profilePicUrl: c.profilePicUrl,
            updatedAt: now,
          },
        },
        upsert: true,
      },
    })),
    { ordered: false },
  );
  return {
    upserted: r.upsertedCount ?? 0,
    modified: r.modifiedCount ?? 0,
  };
}

/**
 * Lookup all chat contacts for a session. Returns the minimal shape needed by
 * the admin conversations panel to render display names instead of raw E.164.
 * Read-only; no PII transformation beyond what the collection already stores.
 */
export async function listContactsForSession(
  sessionId: string,
): Promise<
  Array<{ jid: string; e164: string | null; pushName: string | null; notify: string | null }>
> {
  const c = await chatContacts();
  return c
    .find({ sessionId }, { projection: { _id: 0, jid: 1, e164: 1, pushName: 1, notify: 1 } })
    .toArray();
}

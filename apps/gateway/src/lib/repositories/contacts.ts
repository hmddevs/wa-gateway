/**
 * Contacts repository, per-session WhatsApp contact-book snapshots.
 *
 * Distinct from the legacy `chat_contacts` collection: that one is the
 * pre-history-capture projection used by the older threads aggregation; this
 * one carries the slice-1 `ContactDoc` shape (E.164-keyed, business badge,
 * profile picture URL) and is the authoritative reference for the new
 * conversation viewer.
 *
 * Mutation policy:
 *   - Replace-on-conflict for `(sessionId, e164)`, the most-recent snapshot
 *     wins. Opposite policy to `message_revisions`, which is append-only.
 */
import 'server-only';
import type { ContactDoc, ContactEvent } from '@hmddevs/protocol';
import { contacts } from '../mongo';

/**
 * Replace-or-insert the contact row for `(sessionId, e164)`. Uses
 * `replaceOne` with `upsert: true` rather than `findOneAndUpdate`/`$set` so
 * fields that disappear from a later Baileys snapshot (e.g. `displayName`
 * after the peer clears their profile name) are removed from our row.
 *
 * `capturedAt` is stamped at write-time. `source` propagates from the
 * caller, the worker emits `'history'` during pre-pair backfill and
 * `'live'` for live `contacts.upsert`/`contacts.update` after pair.
 */
// why: replace-on-conflict, opposite of message_revisions which is
// insert-only. A peer renaming themselves should overwrite the row, not
// stack new versions.
export async function upsertContactFromEvent(event: ContactEvent): Promise<void> {
  const coll = await contacts();
  const doc: ContactDoc = {
    sessionId: event.sessionId,
    e164: event.e164,
    waJid: event.waJid,
    ...(event.displayName !== undefined ? { displayName: event.displayName } : {}),
    ...(event.pushName !== undefined ? { pushName: event.pushName } : {}),
    ...(event.profilePictureUrl !== undefined
      ? { profilePictureUrl: event.profilePictureUrl }
      : {}),
    isBusiness: event.isBusiness,
    ...(event.lastSeenAt !== undefined ? { lastSeenAt: event.lastSeenAt } : {}),
    capturedAt: new Date().toISOString(),
    source: event.source,
  };
  await coll.replaceOne({ sessionId: event.sessionId, e164: event.e164 }, doc, { upsert: true });
}

export async function getContact(sessionId: string, e164: string): Promise<ContactDoc | null> {
  const coll = await contacts();
  return coll.findOne({ sessionId, e164 });
}

/**
 * List contacts for a session, ordered by display name (falls back to
 * `pushName`, then `e164`). Default limit 1000, admin viewer uses this for
 * the left-rail render so the cap is generous; pagination can be added when
 * a session ever exceeds it.
 */
export async function listContactsForSession(
  sessionId: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<ContactDoc[]> {
  const coll = await contacts();
  const limit = Math.min(Math.max(opts.limit ?? 1000, 1), 5000);
  const offset = Math.max(opts.offset ?? 0, 0);
  // why: Mongo's collation-based sort is overkill for a 1000-row scan.
  // Sort in memory after fetch, the projection cap above bounds it.
  const rows = await coll.find({ sessionId }).skip(offset).limit(limit).toArray();
  rows.sort((a, b) => {
    const ka = (a.displayName ?? a.pushName ?? a.e164).toLowerCase();
    const kb = (b.displayName ?? b.pushName ?? b.e164).toLowerCase();
    if (ka < kb) return -1;
    if (ka > kb) return 1;
    return 0;
  });
  return rows;
}

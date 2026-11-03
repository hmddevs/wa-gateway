/**
 * Groups repository, persists worker-pushed WhatsApp group metadata.
 *
 * One row per `(sessionId, jid)`, REPLACE-on-conflict (the latest fetch
 * always wins; no history is kept), per `GroupDocSchema`. This is a full
 * document replace, not a partial `$set` merge, so a stale field the worker
 * no longer reports (e.g. a cleared subject) is not left behind from an
 * earlier snapshot.
 */
import 'server-only';
import type { GroupDoc } from '@hmddevs/protocol';
import { groups } from '../mongo';

/**
 * Upsert a single group's metadata snapshot. Full-replace on conflict: the
 * whole document (bar `_id`) is overwritten with `doc`, never merged.
 */
export async function upsertGroup(doc: GroupDoc): Promise<void> {
  const c = await groups();
  await c.replaceOne({ sessionId: doc.sessionId, jid: doc.jid }, doc, { upsert: true });
}

/**
 * Bulk upsert for the `group_metadata_batch` ingest path (initial fetch on
 * connect, potentially hundreds of groups in one push). Each item is a full
 * replace, same semantics as `upsertGroup`, issued as a single bulk write.
 */
export async function upsertGroupBatch(docs: GroupDoc[]): Promise<void> {
  if (docs.length === 0) return;
  const c = await groups();
  await c.bulkWrite(
    docs.map((doc) => ({
      replaceOne: {
        filter: { sessionId: doc.sessionId, jid: doc.jid },
        replacement: doc,
        upsert: true,
      },
    })),
    { ordered: false },
  );
}

/**
 * Fetch stored metadata for every group JID in `jids` belonging to
 * `sessionId`, returned as a `Map` keyed by JID for the caller to
 * in-memory-join onto the chat-events activity aggregation. Never returns
 * rows for a different session, `sessionId` scoping is the tenant-isolation
 * boundary, same as `listSessionGroups`.
 */
export async function findGroupsByJids(
  sessionId: string,
  jids: string[],
): Promise<Map<string, GroupDoc>> {
  if (jids.length === 0) return new Map();
  const c = await groups();
  const rows = await c.find({ sessionId, jid: { $in: jids } }).toArray();
  return new Map(rows.map((r) => [r.jid, r]));
}

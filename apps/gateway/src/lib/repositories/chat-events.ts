/**
 * Chat events repository, persists conversation events that the legacy
 * inbound / outbound paths do not already cover (outbound from the paired
 * phone or another linked device, live group messages, future history sync).
 *
 * Uniqueness is enforced by `(sessionId, waMessageId)`; the worker may
 * re-deliver the same event after a reconnect so duplicate-key errors are
 * treated as success.
 */
import 'server-only';
import type { Document, MongoBulkWriteError } from 'mongodb';
import type { ChatEventDoc } from '@hmddevs/protocol';
import { chatEvents } from '../mongo';

export async function insertChatEvent(
  input: Omit<ChatEventDoc, 'ingestedAt'> & { ingestedAt?: Date },
): Promise<{ duplicate: boolean }> {
  const c = await chatEvents();
  const doc: ChatEventDoc = {
    ...input,
    ingestedAt: input.ingestedAt ?? new Date(),
  };
  try {
    await c.insertOne(doc);
    return { duplicate: false };
  } catch (err: unknown) {
    const code = (err as { code?: number }).code;
    if (code === 11000) return { duplicate: true };
    throw err;
  }
}

/**
 * Bulk insert for the history-sync batch endpoint. Uses `insertMany` with
 * `ordered: false` so a single duplicate (re-sync, worker restart mid-flight)
 * doesn't abort the rest of the batch. Counts duplicate-key errors (11000)
 * separately so the caller can report idempotency outcomes; any other write
 * error is rethrown.
 */
export async function insertChatEventBatch(
  docs: ChatEventDoc[],
): Promise<{ inserted: number; duplicates: number }> {
  if (docs.length === 0) return { inserted: 0, duplicates: 0 };
  const c = await chatEvents();
  try {
    const r = await c.insertMany(docs, { ordered: false });
    return { inserted: r.insertedCount, duplicates: 0 };
  } catch (err: unknown) {
    const bulk = err as MongoBulkWriteError;
    const rawErrors = bulk?.writeErrors;
    if (bulk?.code === 11000 || rawErrors !== undefined) {
      const writeErrors = Array.isArray(rawErrors) ? rawErrors : rawErrors ? [rawErrors] : [];
      const dupes = writeErrors.filter((e) => {
        const code = (e as unknown as { code?: number }).code;
        return code === 11000;
      }).length;
      const nonDup = writeErrors.length - dupes;
      if (nonDup > 0) {
        // why: surface the first non-duplicate write error so a misconfigured
        // schema or storage failure cannot be silently masked by the dedup path.
        throw err;
      }
      // why: when `writeErrors` is empty AND the bulk error carries the global
      // 11000 code, we can't infer how many docs got through from
      // `docs.length - dupes` (dupes is 0 in that branch, so the previous
      // fallback over-reported `inserted`). Trust `insertedCount` from the
      // driver in that case; if absent, treat as zero inserted and the rest
      // duplicates so callers don't double-count.
      if (writeErrors.length === 0 && bulk?.code === 11000) {
        const insertedCount = bulk.insertedCount ?? 0;
        return {
          inserted: insertedCount,
          duplicates: docs.length - insertedCount,
        };
      }
      const inserted = bulk.insertedCount ?? Math.max(docs.length - dupes, 0);
      return { inserted, duplicates: dupes };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Group discovery, GET /v1/groups
// ---------------------------------------------------------------------------

export interface SessionGroupSummary {
  jid: string;
  lastActivityAt: Date;
}

/**
 * Distinct WhatsApp groups this session has any persisted chat-event
 * activity in (either direction, live or history-synced). The `$match` on
 * `sessionId` is the sole tenant-isolation boundary, callers MUST pass the
 * requesting API key's own bound `sessionId` (never a caller-supplied value)
 * so one tenant can never see another tenant's groups.
 *
 * Groups are identified the same way the admin thread viewer separates group
 * rows from DMs (see `listThreadsForSession` in `./messages.ts`):
 * `counterpartyE164: null` plus a `counterpartyJid` ending `@g.us`, this
 * excludes broadcast/newsletter/status JIDs, which also carry
 * `counterpartyE164: null` but are not WhatsApp group threads.
 *
 * No group subject/name is persisted anywhere today (the worker does not yet
 * capture `groupMetadata`), so callers only ever get the JID and the most
 * recent activity timestamp, `subject` is left for the caller/protocol to
 * treat as absent.
 */
export async function listSessionGroups(sessionId: string): Promise<SessionGroupSummary[]> {
  const c = await chatEvents();
  const pipeline: Document[] = [
    {
      $match: {
        sessionId,
        counterpartyE164: null,
        counterpartyJid: { $regex: '@g\\.us$' },
      },
    },
    {
      $group: {
        _id: '$counterpartyJid',
        lastActivityAt: { $max: '$ts' },
      },
    },
    { $sort: { lastActivityAt: -1 } },
    { $project: { _id: 0, jid: '$_id', lastActivityAt: 1 } },
  ];
  return c.aggregate(pipeline).toArray() as Promise<SessionGroupSummary[]>;
}

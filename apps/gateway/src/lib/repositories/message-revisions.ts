/**
 * Message-revisions repository, append-only ledger of edits and deletes.
 *
 * Invariants:
 *   - Insert-only. Never `updateOne`/`replaceOne` on a revision row. The
 *     append-only contract is what makes the audit trail trustworthy.
 *   - `revisionSeq` is monotonic per `(sessionId, messageId)`, or per
 *     `(sessionId, waMessageId)` when the gateway-side UUID hasn't been
 *     resolved yet (race: revision arrives before the original `chat_event`).
 *   - `messageId` is resolved at insert via `messages.findByWaMessageId`. If
 *     the original isn't yet persisted, the row goes in with `messageId: null`
 *     and the viewer aggregation reconciles via the `waMessageId` join index.
 *
 * Wire input is route-shaped (envelope `kind: 'message_revision'`,
 * inner `revisionKind: 'edit' | 'delete'`); the route flattens that into the
 * `MessageRevisionEvent` protocol shape (`kind: 'edit' | 'delete'`) before
 * calling in here.
 */
import 'server-only';
import type {
  MessageRevisionDoc,
  MessageRevisionEvent,
  MessageRevisionKind,
  MessageRevisionBody,
  MessageRevisionDeletedBy,
  MessageRevisionSource,
} from '@hmddevs/protocol';
import { messageRevisions, chatEvents } from '../mongo';
import { findByWaMessageId } from './messages';

const MAX_SEQ_RETRIES = 3;

/**
 * Insert a revision row from a parsed wire event. Resolves the gateway UUID
 * (`messageId`) when the original message is already persisted; falls back to
 * a `messageId: null` row keyed on `(sessionId, waMessageId)` otherwise.
 *
 * `revisionSeq` is computed as `max(existingSeq for this message) + 1`. The
 * compound `(sessionId, messageId, revisionSeq)` unique index guards against
 * concurrent inserts, on 11000 we recompute and retry up to `MAX_SEQ_RETRIES`
 * times before giving up. The same retry covers the `messageId: null` rows
 * via the secondary `(sessionId, waMessageId, revisionSeq)` lookup.
 */
export async function insertRevisionFromEvent(
  event: MessageRevisionEvent,
): Promise<{ inserted: boolean; messageId: string | null; revisionSeq: number }> {
  const coll = await messageRevisions();
  const matched = await findByWaMessageId(event.sessionId, event.waMessageId);
  const messageId = matched?.messageId ?? null;

  let lastErr: unknown = null;
  for (let attempt = 0; attempt < MAX_SEQ_RETRIES; attempt += 1) {
    // why: pick the highest seq seen for this revision target, regardless of
    // whether the original UUID has been resolved yet. This collapses the
    // pre-resolve and post-resolve branches into a single ordering domain.
    const filter: Record<string, unknown> = { sessionId: event.sessionId };
    if (messageId) {
      filter.$or = [{ messageId }, { waMessageId: event.waMessageId }];
    } else {
      filter.waMessageId = event.waMessageId;
    }
    const latest = await coll.findOne(filter, {
      projection: { revisionSeq: 1 },
      sort: { revisionSeq: -1 },
    });
    const nextSeq = (latest?.revisionSeq ?? 0) + 1;

    const doc: MessageRevisionDoc = {
      sessionId: event.sessionId,
      messageId,
      waMessageId: event.waMessageId,
      revisionSeq: nextSeq,
      kind: event.kind as MessageRevisionKind,
      ...(event.body !== undefined ? { body: event.body as MessageRevisionBody } : {}),
      ...(event.deletedBy !== undefined
        ? { deletedBy: event.deletedBy as MessageRevisionDeletedBy }
        : {}),
      ts: event.ts,
      capturedAt: new Date().toISOString(),
      source: event.source as MessageRevisionSource,
    };

    try {
      await coll.insertOne(doc);
      return { inserted: true, messageId, revisionSeq: nextSeq };
    } catch (err: unknown) {
      const code = (err as { code?: number }).code;
      if (code === 11000) {
        // Concurrent insert won the race. Recompute and retry.
        lastErr = err;
        continue;
      }
      throw err;
    }
  }
  throw lastErr ?? new Error('insertRevisionFromEvent: exhausted retries');
}

/**
 * List all revisions for one resolved message, oldest-first. Used by the
 * admin viewer when it needs an explicit per-message history (the thread
 * aggregation already inlines revisions via `$lookup`).
 */
export async function listRevisionsForMessage(
  sessionId: string,
  messageId: string,
): Promise<MessageRevisionDoc[]> {
  const coll = await messageRevisions();
  return coll.find({ sessionId, messageId }).sort({ revisionSeq: 1 }).toArray();
}

/**
 * List all revisions for a thread, optionally filtered by `since` on `ts`.
 * Resolves the message ids by joining with `messages` (outbound) and
 * `inbound_messages` (inbound). Used by ad-hoc admin queries; the live viewer
 * pipeline does its own join.
 *
 * `e164OrJid` is matched against the outbound `to` field, the inbound
 * `fromE164` field, and against `chat_events.counterpartyE164` /
 * `counterpartyJid`. The result is a union of revisions across all message
 * sources for that thread.
 */
export async function listRevisionsForThread(
  sessionId: string,
  e164OrJid: string,
  since?: Date,
): Promise<MessageRevisionDoc[]> {
  const coll = await messageRevisions();
  // why: pull the candidate waMessageIds from chat_events (the broadest
  // source covering both DMs and groups) and match revisions by waMessageId.
  // The viewer aggregation already does the heavier per-message inlining.
  const events = await chatEvents();
  const candidateIds = await events
    .find(
      {
        sessionId,
        $or: [{ counterpartyE164: e164OrJid }, { counterpartyJid: e164OrJid }],
      },
      { projection: { _id: 0, waMessageId: 1 } },
    )
    .toArray();
  const waIds = candidateIds
    .map((d) => (d as { waMessageId?: string }).waMessageId)
    .filter((s): s is string => typeof s === 'string' && s.length > 0);
  if (waIds.length === 0) return [];
  const filter: Record<string, unknown> = {
    sessionId,
    waMessageId: { $in: waIds },
  };
  if (since) filter.ts = { $gte: since.toISOString() };
  return coll.find(filter).sort({ ts: 1, revisionSeq: 1 }).toArray();
}

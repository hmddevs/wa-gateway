/**
 * Message-reactions repository, per-peer reaction snapshots.
 *
 * Mutation policy:
 *   - Replace-on-conflict for `(sessionId, waMessageId, fromJid)`. One row per
 *     peer per target message; the latest reaction wins. Empty-string `emoji`
 *     keeps the row in place as an audit record of a cleared reaction. The
 *     viewer aggregation filters out cleared rows so empty pills never render.
 *
 * Distinct semantic from `message_revisions`, which is append-only.
 */
import 'server-only';
import type { MessageReactionDoc } from '@hmddevs/protocol';
import { messageReactions } from '../mongo';
import { findByWaMessageId } from './messages';
import { jidToE164 } from '../phone';

/**
 * Structural shape of a reaction event the route passes in. Captures the
 * fields the repo needs from both the protocol `ReactionEvent` (discriminator
 * `type: 'reaction'`) and the route-local `Reaction` envelope (discriminator
 * `kind: 'reaction'`). The two diverge on the discriminator name; the rest
 * of the fields are aligned.
 */
export interface ReactionUpsertInput {
  targetWaMessageId: string;
  targetFromMe: boolean;
  fromJid: string;
  emoji: string;
  /** Envelope `at` ISO timestamp, when the reaction was observed. */
  at: string;
}

// why: replace-on-conflict per (sessionId, waMessageId, fromJid). Different
// from message_revisions (append-only), WhatsApp itself surfaces only the
// most-recent emoji per peer; we mirror that and keep cleared rows for audit.
export async function upsertReactionFromEvent(
  sessionId: string,
  event: ReactionUpsertInput,
): Promise<void> {
  const coll = await messageReactions();

  // Resolve the gateway UUID when the target was an outbound message we sent.
  // Inbound-target reactions stay messageId-less; the read-side join can fall
  // back to the raw `waMessageId` lookup index.
  let messageId: string | undefined;
  if (event.targetFromMe) {
    const matched = await findByWaMessageId(sessionId, event.targetWaMessageId);
    if (matched?.messageId) {
      messageId = matched.messageId;
    }
  }

  // The wire `from` field is the reactor's E.164; in groups where Baileys
  // can't resolve it, the worker still emits a JID-based row. Use the JID
  // as the source of truth and derive E.164 defensively.
  const fromE164 = jidToE164(event.fromJid);

  const doc: MessageReactionDoc = {
    sessionId,
    waMessageId: event.targetWaMessageId,
    ...(messageId !== undefined ? { messageId } : {}),
    targetFromMe: event.targetFromMe,
    fromJid: event.fromJid,
    fromE164,
    emoji: event.emoji,
    ts: event.at,
    capturedAt: new Date().toISOString(),
  };

  await coll.replaceOne(
    { sessionId, waMessageId: event.targetWaMessageId, fromJid: event.fromJid },
    doc,
    { upsert: true },
  );
}

/**
 * List reactions for one message, ordered by `ts` ascending. Cleared rows
 * (`emoji === ''`) are included, callers that want a render-ready set
 * should filter them out at projection time.
 */
export async function listReactionsForMessage(
  sessionId: string,
  waMessageId: string,
): Promise<MessageReactionDoc[]> {
  const coll = await messageReactions();
  return coll.find({ sessionId, waMessageId }).sort({ ts: 1 }).toArray();
}

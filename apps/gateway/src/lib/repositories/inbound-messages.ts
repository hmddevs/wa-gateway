/**
 * Inbound WhatsApp messages received by the worker and forwarded to the
 * gateway via the worker callback. Persisted minimally, full content is
 * not stored alongside the metadata to keep PII surface small.
 *
 * Indexes for `waMessageId` and `at` are created in `mongo.ts`. `fromHash`
 * lets us count distinct senders without storing raw E.164 in this collection.
 */
import 'server-only';
import type { ObjectId } from 'mongodb';
import { col } from '../mongo';

export interface InboundMessageDoc {
  _id?: ObjectId;
  inboundId: string;
  sessionId: string;
  workerId: string;
  waMessageId: string;
  /** SHA-256 hex of the sender's E.164. We store this for grouping; the raw E.164 is in `from`. */
  fromHash: string;
  from: string;
  /**
   * Sender's E.164 (with leading `+`), derived from the raw Baileys JID at
   * persistence time. Used by the admin viewer aggregation as the thread key.
   * `null` only when the JID isn't `@s.whatsapp.net` (groups, broadcasts), * those should never reach this collection (worker routes them to
   * `chat_events`), but the field is nullable defensively.
   */
  fromE164: string | null;
  content:
    | { kind: 'text'; text: string }
    | { kind: 'image'; mediaUrl?: string; mediaMimeType?: string; caption?: string }
    | {
        kind: 'document';
        mediaUrl?: string;
        mediaFileName?: string;
        mediaMimeType?: string;
        caption?: string;
      }
    | { kind: 'audio' | 'video' | 'sticker' | 'other' };
  receivedAt: Date;
}

export async function insertInbound(doc: InboundMessageDoc): Promise<{ inserted: boolean }> {
  const c = await col<InboundMessageDoc>('inbound_messages');
  try {
    await c.insertOne(doc);
    return { inserted: true };
  } catch (err: unknown) {
    // Duplicate waMessageId, worker re-delivered. Treat as already-stored.
    const code = (err as { code?: number }).code;
    if (code === 11000) return { inserted: false };
    throw err;
  }
}

export async function findInboundByWaMessageId(
  waMessageId: string,
): Promise<InboundMessageDoc | null> {
  const c = await col<InboundMessageDoc>('inbound_messages');
  return c.findOne({ waMessageId });
}

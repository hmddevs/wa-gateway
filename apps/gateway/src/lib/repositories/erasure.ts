/**
 * Erase contact data, data hygiene.
 *
 * Hard-deletes every stored trace of a contact on a single session: outbound
 * messages, inbound messages, chat events, any legacy consent records, and the
 * contact snapshot. Returns per-collection deletion counts for the audit record.
 *
 * IMPORTANT: opt-out (`opt_outs`) rows are INTENTIONALLY left in place. Erasing
 * a contact must never resurrect their ability to be messaged, the suppression
 * has to survive the erasure. The `consents` collection is no longer written
 * by the gateway; the delete here remains so any historical rows are swept too.
 */
import 'server-only';
import { col } from '../mongo';

export interface EraseResult {
  messages: number;
  inboundMessages: number;
  chatEvents: number;
  consents: number;
  contacts: number;
}

interface MinimalDoc {
  _id?: unknown;
}

/**
 * Erase all stored data for `phone` (E.164) on `sessionId`. Each deletion is
 * scoped to the session so erasure on one session never touches another. The
 * deletes run sequentially (small collections, no benefit to parallelism here)
 * and each returns the count actually removed.
 */
export async function eraseContact(sessionId: string, phone: string): Promise<EraseResult> {
  const messagesCol = await col<MinimalDoc>('messages');
  const inboundCol = await col<MinimalDoc>('inbound_messages');
  const chatEventsCol = await col<MinimalDoc>('chat_events');
  const consentsCol = await col<MinimalDoc>('consents');
  const contactsCol = await col<MinimalDoc>('contacts');

  // Field names track the live schemas, not the route's parameter name:
  //   messages.to, outbound recipient (E.164); no `from` field here
  //   inbound_messages.fromE164, sender E.164 (`from` holds the raw Baileys JID)
  //   chat_events.counterpartyE164, the peer's E.164
  //   consents.phone / contacts.e164, keyed directly
  const messages = await messagesCol.deleteMany({ sessionId, to: phone });
  const inboundMessages = await inboundCol.deleteMany({ sessionId, fromE164: phone });
  const chatEvents = await chatEventsCol.deleteMany({ sessionId, counterpartyE164: phone });
  const consents = await consentsCol.deleteMany({ sessionId, phone });
  const contacts = await contactsCol.deleteMany({ sessionId, e164: phone });

  return {
    messages: messages.deletedCount ?? 0,
    inboundMessages: inboundMessages.deletedCount ?? 0,
    chatEvents: chatEvents.deletedCount ?? 0,
    consents: consents.deletedCount ?? 0,
    contacts: contacts.deletedCount ?? 0,
  };
}

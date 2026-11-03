/**
 * E.164 normaliser. Strips spaces/dashes/parens. Accepts either
 * `+<digits>` or plain digits (we coerce to `+` prefix).
 * Valid range: 8-15 digits (ITU-T E.164 spec).
 */
export function normalisePhone(input: string): string | null {
  if (typeof input !== 'string') return null;
  const cleaned = input.replace(/[\s\-().]/g, '');
  const m = /^\+?([0-9]{8,15})$/.exec(cleaned);
  if (!m) return null;
  return `+${m[1]}`;
}

/**
 * Convert an E.164 phone (with leading `+`) to a Baileys JID for 1:1 chats.
 * Mirrors the worker's `toJid` helper exactly (digits + `@s.whatsapp.net`).
 * Returns null when the input is not a valid E.164 string.
 */
export function jidFromE164(e164: string): string | null {
  if (typeof e164 !== 'string') return null;
  const m = /^\+?([0-9]{8,15})$/.exec(e164.trim());
  if (!m) return null;
  return `${m[1]}@s.whatsapp.net`;
}

/**
 * Convert a Baileys individual JID (`{digits}@s.whatsapp.net`) to E.164.
 * Returns null for group JIDs, broadcast JIDs, or malformed strings.
 */
export function jidToE164(jid: string): string | null {
  if (typeof jid !== 'string') return null;
  // Allow optional LID device suffix: `{digits}:{device}@s.whatsapp.net`.
  const m = /^(\d{8,15})(?::\d+)?@s\.whatsapp\.net$/.exec(jid.trim());
  if (!m) return null;
  return `+${m[1]}`;
}

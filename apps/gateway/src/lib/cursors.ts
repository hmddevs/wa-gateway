/** Opaque base64url cursor helpers for admin-side paginated reads. */
import 'server-only';

export function encodeAdminThreadCursor(c: { ts: Date; id: string }): string {
  return Buffer.from(JSON.stringify({ ts: c.ts.toISOString(), id: c.id })).toString('base64url');
}

export function decodeAdminThreadCursor(
  s: string | null | undefined,
): { ts: Date; id: string } | null {
  if (!s) return null;
  try {
    const raw = Buffer.from(s, 'base64url').toString('utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const obj = parsed as { ts?: unknown; id?: unknown };
    if (typeof obj.ts !== 'string' || typeof obj.id !== 'string') return null;
    if (obj.id.length === 0) return null;
    const ts = new Date(obj.ts);
    if (Number.isNaN(ts.getTime())) return null;
    return { ts, id: obj.id };
  } catch {
    return null;
  }
}

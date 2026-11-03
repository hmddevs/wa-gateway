/**
 * Deterministic JSON serialisation.
 * Rules:
 *   - Object keys sorted lexicographically (recursively).
 *   - No trailing whitespace, no pretty-printing.
 *   - `undefined` values are dropped (JSON semantics).
 *   - Dates are serialised as ISO 8601 strings (UTC).
 * This is the exact representation used for HMAC signing and audit hashing.
 * The worker MUST implement a byte-for-byte equivalent.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sort(value));
}

function sort(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v;
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(sort);
  const out: Record<string, unknown> = {};
  const keys = Object.keys(v as Record<string, unknown>).sort();
  for (const k of keys) {
    const cur = (v as Record<string, unknown>)[k];
    if (cur === undefined) continue;
    out[k] = sort(cur);
  }
  return out;
}

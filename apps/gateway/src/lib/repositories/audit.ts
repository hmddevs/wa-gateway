/**
 * Hash-chained audit log.
 *
 * Each entry stores:
 *   seq       monotonic (counters["audit_log"])
 *   at        server time ISO
 *   actor     { kind: 'admin' | 'system' | 'apiKey', id, email? }
 *   action    dotted path e.g. 'api_key.create', 'message.send'
 *   target    optional { kind, id }
 *   meta      redacted metadata (no PII/no secrets)
 *   prevHash  sha256 hex of previous entry's `hash` (or '0'*64 for seq=1)
 *   hash      sha256(canonicalJson({ …entry, hash: '' }))
 *
 * Verification walks the chain in seq order and re-derives every hash.
 */
import 'server-only';
import { createHash } from 'node:crypto';
import { canonicalJson } from '../canonical-json';
import { col } from '../mongo';
import { nextSequence } from './counters';

export interface AuditActor {
  kind: 'admin' | 'system' | 'apiKey';
  id: string;
  email?: string;
}

export interface AuditTarget {
  kind: string;
  id: string;
}

export interface AuditEntryDoc {
  seq: number;
  at: Date;
  actor: AuditActor;
  action: string;
  target?: AuditTarget;
  meta?: Record<string, unknown>;
  prevHash: string;
  hash: string;
  ip?: string;
  userAgent?: string;
}

const ZERO_HASH = '0'.repeat(64);

function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export async function appendAudit(input: {
  actor: AuditActor;
  action: string;
  target?: AuditTarget;
  meta?: Record<string, unknown>;
  ip?: string;
  userAgent?: string;
}): Promise<AuditEntryDoc> {
  const seq = await nextSequence('audit_log');
  const c = await col<AuditEntryDoc>('audit_log');
  const prev = seq > 1 ? await c.findOne({ seq: seq - 1 }, { projection: { hash: 1 } }) : null;
  const prevHash = prev?.hash ?? ZERO_HASH;

  const bodyForHash = {
    seq,
    at: new Date(),
    actor: input.actor,
    action: input.action,
    target: input.target,
    meta: input.meta,
    ip: input.ip,
    userAgent: input.userAgent,
    prevHash,
    hash: '', // placeholder, canonicalJson drops empty-but-explicit? no, it keeps.
  };
  const hash = sha256Hex(canonicalJson({ ...bodyForHash, hash: '' }));
  const doc: AuditEntryDoc = { ...bodyForHash, hash };
  await c.insertOne(doc);
  return doc;
}

/**
 * Verify the entire audit chain. Returns the first broken seq, or null if OK.
 */
export async function verifyAuditChain(): Promise<{ ok: true } | { ok: false; brokenAt: number }> {
  const c = await col<AuditEntryDoc>('audit_log');
  // Exclude `_id`: the hash in `appendAudit` is computed before `insertOne`
  // adds it, so re-hashing must not see it or every entry would mismatch
  // (which is exactly the "Chain broken at seq 1" false positive).
  const cursor = c.find({}, { sort: { seq: 1 }, projection: { _id: 0 } });
  let expectedPrev = ZERO_HASH;
  let expectedSeq = 1;
  for await (const entry of cursor) {
    if (entry.seq !== expectedSeq) return { ok: false, brokenAt: expectedSeq };
    if (entry.prevHash !== expectedPrev) return { ok: false, brokenAt: entry.seq };
    const recomputed = sha256Hex(canonicalJson({ ...entry, hash: '' }));
    if (recomputed !== entry.hash) return { ok: false, brokenAt: entry.seq };
    expectedPrev = entry.hash;
    expectedSeq++;
  }
  return { ok: true };
}

export async function listAudit(params: {
  limit?: number;
  before?: number;
  actionPrefix?: string;
}): Promise<AuditEntryDoc[]> {
  const c = await col<AuditEntryDoc>('audit_log');
  const q: Record<string, unknown> = {};
  if (typeof params.before === 'number') q.seq = { $lt: params.before };
  if (params.actionPrefix) q.action = { $regex: `^${escapeRegex(params.actionPrefix)}` };
  return c
    .find(q)
    .sort({ seq: -1 })
    .limit(Math.min(params.limit ?? 50, 200))
    .toArray();
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

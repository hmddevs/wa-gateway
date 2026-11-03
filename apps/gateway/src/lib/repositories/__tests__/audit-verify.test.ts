/**
 * verifyAuditChain, hash-chain integrity check.
 *
 * Regression guard for the "Chain broken at seq 1" false positive: the stored
 * doc carries a Mongo `_id` that was NOT part of the hash input (the hash is
 * computed in `appendAudit` before `insertOne` adds `_id`). Verification must
 * therefore project `_id` out, or every entry mismatches. The mock mirrors real
 * Mongo: it carries `_id` and only drops it when `{ projection: { _id: 0 } }`
 * is passed, so this test fails against a verifier that forgets the projection.
 *
 * Mocked boundary: @/lib/mongo, col().
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { canonicalJson } from '@/lib/canonical-json';

const { findOpts, docsRef } = vi.hoisted(() => ({
  findOpts: { last: undefined as unknown },
  docsRef: { docs: [] as Array<Record<string, unknown>> },
}));

vi.mock('@/lib/mongo', () => ({
  col: vi.fn(async () => ({
    find: (_q: unknown, opts: { projection?: { _id?: 0 | 1 } }) => {
      findOpts.last = opts;
      const stripId = opts?.projection?._id === 0;
      const rows = docsRef.docs.map((d) => {
        if (!stripId) return d;
        const { _id, ...rest } = d;
        void _id;
        return rest;
      });
      return {
        async *[Symbol.asyncIterator]() {
          for (const r of rows) yield r;
        },
      };
    },
  })),
}));

import { verifyAuditChain } from '@/lib/repositories/audit';

const ZERO_HASH = '0'.repeat(64);
const sha256Hex = (s: string) => createHash('sha256').update(s).digest('hex');

/** Build a genuine chained entry exactly as `appendAudit` hashes it. */
function entry(seq: number, prevHash: string, action: string): Record<string, unknown> {
  const body = {
    seq,
    at: new Date('2026-01-01T00:00:00.000Z'),
    actor: { kind: 'system', id: 'sys' },
    action,
    prevHash,
  };
  const hash = sha256Hex(canonicalJson({ ...body, hash: '' }));
  // `_id` is what real Mongo adds post-insert and is NOT in the hash input.
  return { _id: `id-${seq}`, ...body, hash };
}

beforeEach(() => {
  findOpts.last = undefined;
  docsRef.docs = [];
});

describe('verifyAuditChain', () => {
  it('passes for a valid chain and projects `_id` out of the re-hash', async () => {
    const e1 = entry(1, ZERO_HASH, 'test.one');
    const e2 = entry(2, e1.hash as string, 'test.two');
    docsRef.docs = [e1, e2];

    const res = await verifyAuditChain();

    expect(res).toEqual({ ok: true });
    // The projection is the actual fix, assert it is requested.
    expect((findOpts.last as { projection?: { _id?: number } })?.projection?._id).toBe(0);
  });

  it('detects a genuine tamper (mutated action breaks the hash)', async () => {
    const e1 = entry(1, ZERO_HASH, 'test.one');
    const e2 = entry(2, e1.hash as string, 'test.two');
    e2.action = 'tampered'; // hash no longer matches the stored value
    docsRef.docs = [e1, e2];

    const res = await verifyAuditChain();

    expect(res).toEqual({ ok: false, brokenAt: 2 });
  });

  it('detects a prevHash break (re-linked entry)', async () => {
    const e1 = entry(1, ZERO_HASH, 'test.one');
    const e2 = entry(2, sha256Hex('not-the-real-prev'), 'test.two');
    docsRef.docs = [e1, e2];

    const res = await verifyAuditChain();

    expect(res).toEqual({ ok: false, brokenAt: 2 });
  });
});

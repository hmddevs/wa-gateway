/**
 * ensureRetentionTtl, idempotent 90-day TTL on the shared-tier write
 * collections. Asserts it creates a TTL index when absent, patches an existing
 * non-TTL index in place via collMod, no-ops when the TTL already matches, and
 * is never wired onto the append-only audit_log.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/env', () => ({ env: { MONGODB_URI: 'mongodb://test', MONGODB_DB: 'test' } }));
vi.mock('@/lib/redis', () => ({ getRedis: vi.fn() }));
vi.mock('@/lib/phone', () => ({ jidToE164: vi.fn() }));

import { ensureRetentionTtl, RETENTION_TTL_SECONDS } from '../mongo';

function makeDb(indexesByColl: Record<string, Array<Record<string, unknown>>>) {
  const createIndexes = vi.fn().mockResolvedValue(undefined);
  const command = vi.fn().mockResolvedValue(undefined);
  const db = {
    collection: (name: string) => ({
      indexes: vi.fn().mockResolvedValue(indexesByColl[name] ?? []),
      createIndexes,
    }),
    command,
  };
  return { db, createIndexes, command };
}

beforeEach(() => vi.clearAllMocks());

describe('ensureRetentionTtl', () => {
  it('TTL constant is 90 days', () => {
    expect(RETENTION_TTL_SECONDS).toBe(90 * 24 * 60 * 60);
  });

  it('creates a TTL index when no index exists on the key', async () => {
    const { db, createIndexes, command } = makeDb({ messages: [] });
    await ensureRetentionTtl(db as never, 'messages', 'createdAt', 1, 'ttl_90d');
    expect(createIndexes).toHaveBeenCalledWith([
      { key: { createdAt: 1 }, expireAfterSeconds: RETENTION_TTL_SECONDS, name: 'ttl_90d' },
    ]);
    expect(command).not.toHaveBeenCalled();
  });

  it('patches an existing non-TTL index in place via collMod', async () => {
    const { db, createIndexes, command } = makeDb({
      messages: [{ name: 'ttl_90d', key: { createdAt: 1 } }],
    });
    await ensureRetentionTtl(db as never, 'messages', 'createdAt', 1, 'ttl_90d');
    expect(createIndexes).not.toHaveBeenCalled();
    expect(command).toHaveBeenCalledWith({
      collMod: 'messages',
      index: { name: 'ttl_90d', expireAfterSeconds: RETENTION_TTL_SECONDS },
    });
  });

  it('patches a -1 single-field index (inbound_messages.at_desc)', async () => {
    const { db, command } = makeDb({
      inbound_messages: [{ name: 'at_desc', key: { at: -1 } }],
    });
    await ensureRetentionTtl(db as never, 'inbound_messages', 'at', -1, 'at_desc');
    expect(command).toHaveBeenCalledWith({
      collMod: 'inbound_messages',
      index: { name: 'at_desc', expireAfterSeconds: RETENTION_TTL_SECONDS },
    });
  });

  it('no-ops when the TTL already matches', async () => {
    const { db, createIndexes, command } = makeDb({
      chat_events: [
        { name: 'chat_events_ttl', key: { ts: 1 }, expireAfterSeconds: RETENTION_TTL_SECONDS },
      ],
    });
    await ensureRetentionTtl(db as never, 'chat_events', 'ts', 1, 'chat_events_ttl');
    expect(createIndexes).not.toHaveBeenCalled();
    expect(command).not.toHaveBeenCalled();
  });

  it('ignores a compound index that merely includes the key field', async () => {
    // A compound index (createdAt + something) must NOT be treated as the TTL
    // index, TTL requires a single-field index. The picker creates a fresh one.
    const { db, createIndexes } = makeDb({
      messages: [{ name: 'apiKeyId_createdAt', key: { apiKeyId: 1, createdAt: -1 } }],
    });
    await ensureRetentionTtl(db as never, 'messages', 'createdAt', 1, 'ttl_90d');
    expect(createIndexes).toHaveBeenCalledTimes(1);
  });
});

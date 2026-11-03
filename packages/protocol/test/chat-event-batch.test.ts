/**
 * Wire-schema round-trips for the history-sync types introduced in PR-2:
 * ChatEventBatchItemSchema (the inner event shape consumed by the batch
 * route), ContactBatchItemSchema (the inner contact shape), and the
 * HeartbeatSchema extension for historySyncProgress.
 *
 * The wrapper envelopes that previously lived here (`ChatEventBatchSchema`,
 * `ContactBatchSchema`) were deleted: they keyed on `type` while the actual
 * wire uses `kind`. The wrapper shape lives next to the other `kind`-keyed
 * callback envelopes in the batch ingress route; this test guards the items
 * that cross the boundary.
 *
 * Pure Zod parse checks, no I/O, no mocks.
 */
import { describe, it, expect } from 'vitest';
import { ChatEventBatchItemSchema, ContactBatchItemSchema, HeartbeatSchema } from '../src/wire.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const ENVELOPE = {
  nonce: '00000000-0000-4000-8000-000000000001',
  at: '2026-04-29T12:00:00.000Z',
  sig: 'a'.repeat(64),
} as const;

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    waMessageId: 'wa-hist-001',
    direction: 'in_history',
    source: 'history_sync',
    counterpartyJid: '447700900000@s.whatsapp.net',
    counterpartyE164: '+447700900000',
    content: { kind: 'text', text: 'Hello from history' },
    ts: '2026-04-29T12:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// ChatEventBatchItemSchema, valid events
// ---------------------------------------------------------------------------

describe('ChatEventBatchItemSchema, happy path', () => {
  it('parses a valid in_history event', () => {
    const result = ChatEventBatchItemSchema.safeParse(makeEvent());
    expect(result.success).toBe(true);
  });

  it('parses an out_history event', () => {
    const result = ChatEventBatchItemSchema.safeParse(
      makeEvent({ direction: 'out_history', waMessageId: 'wa-out-hist-001' }),
    );
    expect(result.success).toBe(true);
  });

  it('rejects an event missing waMessageId', () => {
    const { waMessageId: _omit, ...rest } = makeEvent();
    const result = ChatEventBatchItemSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it('rejects a non-ISO ts', () => {
    const result = ChatEventBatchItemSchema.safeParse(makeEvent({ ts: 'not-a-date' }));
    expect(result.success).toBe(false);
  });

  it('accepts counterpartyE164: null (groups)', () => {
    const result = ChatEventBatchItemSchema.safeParse(
      makeEvent({ counterpartyE164: null, counterpartyJid: '12345@g.us' }),
    );
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ContactBatchItemSchema, valid contacts
// ---------------------------------------------------------------------------

describe('ContactBatchItemSchema, happy path', () => {
  it('parses a fully-populated contact', () => {
    const result = ContactBatchItemSchema.safeParse({
      jid: '447700900001@s.whatsapp.net',
      e164: '+447700900001',
      pushName: 'Alice',
      notify: null,
      verifiedName: null,
      profilePicUrl: 'https://cdn.test/alice.jpg',
    });
    expect(result.success).toBe(true);
  });

  it('accepts e164: null', () => {
    const result = ContactBatchItemSchema.safeParse({
      jid: '12345@g.us',
      e164: null,
      pushName: null,
      notify: null,
      verifiedName: null,
      profilePicUrl: null,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.e164).toBeNull();
    }
  });

  it('accepts a non-URL string as profilePicUrl', () => {
    // profilePicUrl is z.string().nullable(), intentionally not URL-validated
    // because Baileys may return non-standard CDN paths or short-lived tokens.
    const result = ContactBatchItemSchema.safeParse({
      jid: '447700900001@s.whatsapp.net',
      e164: null,
      pushName: null,
      notify: null,
      verifiedName: null,
      profilePicUrl: 'not-a-url-just-a-token',
    });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// HeartbeatSchema, historySyncProgress extension
// ---------------------------------------------------------------------------

const HEARTBEAT_BASE = {
  type: 'heartbeat' as const,
  ...ENVELOPE,
  workerId: 'worker-1',
  sessionId: 'session-1',
  waConnected: true,
  waNumber: '+447700900000',
  queueLocalDepth: 0,
  version: '1.0.0',
  buildHash: 'abc123',
};

describe('HeartbeatSchema, historySyncProgress present', () => {
  it('parses a heartbeat with historySyncProgress set', () => {
    const result = HeartbeatSchema.safeParse({
      ...HEARTBEAT_BASE,
      historySyncProgress: { received: 100, isLatest: false },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.historySyncProgress?.received).toBe(100);
      expect(result.data.historySyncProgress?.isLatest).toBe(false);
    }
  });
});

describe('HeartbeatSchema, historySyncProgress null', () => {
  it('parses a heartbeat with historySyncProgress: null', () => {
    const result = HeartbeatSchema.safeParse({
      ...HEARTBEAT_BASE,
      historySyncProgress: null,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.historySyncProgress).toBeNull();
    }
  });
});

describe('HeartbeatSchema, historySyncProgress absent', () => {
  it('parses a heartbeat with historySyncProgress field omitted', () => {
    const result = HeartbeatSchema.safeParse(HEARTBEAT_BASE);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.historySyncProgress).toBeUndefined();
    }
  });
});

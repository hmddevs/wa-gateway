/**
 * Wire-schema round-trip for ChatEventSchema.
 *
 * Exercises the discriminated-union member added to WorkerToGatewaySchema.
 * These are pure Zod parse checks, no I/O, no mocks.
 */
import { describe, it, expect } from 'vitest';
import { ChatEventSchema } from '../src/wire.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const ENVELOPE = {
  nonce: '00000000-0000-4000-8000-000000000001',
  at: '2026-04-29T12:00:00.000Z',
  sig: 'a'.repeat(64),
} as const;

const DM_OUTBOUND = {
  type: 'chat_event' as const,
  ...ENVELOPE,
  workerId: 'worker-1',
  sessionId: 'session-1',
  waMessageId: 'wa-out-001',
  direction: 'out_device' as const,
  source: 'live' as const,
  counterpartyJid: '447700900000@s.whatsapp.net',
  counterpartyE164: '+447700900000',
  content: { kind: 'text' as const, text: 'Hello' },
  ts: '2026-04-29T12:00:00.000Z',
};

const GROUP_INBOUND = {
  type: 'chat_event' as const,
  ...ENVELOPE,
  workerId: 'worker-1',
  sessionId: 'session-1',
  waMessageId: 'wa-grp-001',
  direction: 'in' as const,
  source: 'live' as const,
  counterpartyJid: '12345678901@g.us',
  counterpartyE164: null,
  content: { kind: 'text' as const, text: 'Group hello' },
  ts: '2026-04-29T12:00:01.000Z',
};

// ---------------------------------------------------------------------------
// Valid payloads
// ---------------------------------------------------------------------------

describe('ChatEventSchema, DM outbound payload', () => {
  it('parses a valid out_device / live DM payload', () => {
    const result = ChatEventSchema.safeParse(DM_OUTBOUND);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.direction).toBe('out_device');
      expect(result.data.counterpartyE164).toBe('+447700900000');
    }
  });
});

describe('ChatEventSchema, group inbound payload', () => {
  it('parses a valid in / live group payload with null counterpartyE164', () => {
    const result = ChatEventSchema.safeParse(GROUP_INBOUND);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.direction).toBe('in');
      expect(result.data.counterpartyE164).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// direction enum guard
// ---------------------------------------------------------------------------

describe('ChatEventSchema, direction validation', () => {
  it('rejects a direction value outside the allowed enum', () => {
    const result = ChatEventSchema.safeParse({ ...DM_OUTBOUND, direction: 'sideways' });
    expect(result.success).toBe(false);
  });

  it('accepts all four valid direction values', () => {
    const directions = ['in', 'out_device', 'in_history', 'out_history'] as const;
    for (const direction of directions) {
      const result = ChatEventSchema.safeParse({ ...DM_OUTBOUND, direction });
      expect(result.success, `direction '${direction}' should be valid`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// counterpartyE164, E.164 string and null
// ---------------------------------------------------------------------------

describe('ChatEventSchema, counterpartyE164 variants', () => {
  it('accepts a valid E.164 phone number', () => {
    const result = ChatEventSchema.safeParse({ ...DM_OUTBOUND, counterpartyE164: '+14155550100' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.counterpartyE164).toBe('+14155550100');
    }
  });

  it('accepts null for group events', () => {
    const result = ChatEventSchema.safeParse({ ...DM_OUTBOUND, counterpartyE164: null });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.counterpartyE164).toBeNull();
    }
  });

  it('rejects a non-E.164 string', () => {
    const result = ChatEventSchema.safeParse({ ...DM_OUTBOUND, counterpartyE164: '07700900000' });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Required field: waMessageId
// ---------------------------------------------------------------------------

describe('ChatEventSchema, waMessageId required', () => {
  it('rejects a payload missing waMessageId', () => {
    const { waMessageId: _omit, ...rest } = DM_OUTBOUND;
    const result = ChatEventSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it('rejects an empty waMessageId', () => {
    const result = ChatEventSchema.safeParse({ ...DM_OUTBOUND, waMessageId: '' });
    expect(result.success).toBe(false);
  });
});

/**
 * Wire-schema round-trips for the admin SSE stream types.
 *
 * Covers AdminStreamInboundSchema, AdminStreamChatEventSchema,
 * AdminStreamMessageStatusSchema, AdminStreamEventSchema (discriminated union),
 * and AdminStreamEnvelopeSchema. Pure Zod parse checks, no I/O, no mocks.
 */
import { describe, it, expect } from 'vitest';
import {
  AdminStreamInboundSchema,
  AdminStreamChatEventSchema,
  AdminStreamMessageStatusSchema,
  AdminStreamEventSchema,
  AdminStreamEnvelopeSchema,
} from '../src/api.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const ISO_TS = '2026-04-29T12:00:00.000Z';

const VALID_INBOUND = {
  kind: 'inbound' as const,
  sessionId: 'session-1',
  counterpartyE164: '+447700900000',
  ts: ISO_TS,
  preview: 'Hello, world',
  messageId: 'inbound-id-001',
};

const VALID_CHAT_EVENT_OUT = {
  kind: 'chat_event' as const,
  sessionId: 'session-1',
  counterpartyE164: '+447700900000',
  direction: 'out_device' as const,
  ts: ISO_TS,
  preview: 'Sent from device',
  waMessageId: 'wa-out-001',
};

const VALID_CHAT_EVENT_IN_GROUP = {
  kind: 'chat_event' as const,
  sessionId: 'session-1',
  counterpartyE164: null,
  direction: 'in' as const,
  ts: ISO_TS,
  preview: 'Group message',
  waMessageId: 'wa-grp-001',
};

const VALID_STATUS = {
  kind: 'message_status' as const,
  sessionId: 'session-1',
  messageId: 'msg-uuid-001',
  status: 'sent' as const,
};

// ---------------------------------------------------------------------------
// AdminStreamInboundSchema
// ---------------------------------------------------------------------------

describe('AdminStreamInboundSchema, valid payload', () => {
  it('parses a fully-populated inbound event', () => {
    const result = AdminStreamInboundSchema.safeParse(VALID_INBOUND);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.kind).toBe('inbound');
      expect(result.data.counterpartyE164).toBe('+447700900000');
    }
  });

  it('parses a preview at exactly the 200-char limit', () => {
    const result = AdminStreamInboundSchema.safeParse({
      ...VALID_INBOUND,
      preview: 'a'.repeat(200),
    });
    expect(result.success).toBe(true);
  });
});

describe('AdminStreamInboundSchema, invalid payloads', () => {
  it('rejects a non-E.164 counterpartyE164', () => {
    const result = AdminStreamInboundSchema.safeParse({
      ...VALID_INBOUND,
      counterpartyE164: '07700900000',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a preview longer than 200 chars', () => {
    const result = AdminStreamInboundSchema.safeParse({
      ...VALID_INBOUND,
      preview: 'x'.repeat(201),
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-ISO ts', () => {
    const result = AdminStreamInboundSchema.safeParse({
      ...VALID_INBOUND,
      ts: 'not-a-date',
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AdminStreamChatEventSchema
// ---------------------------------------------------------------------------

describe('AdminStreamChatEventSchema, valid payloads', () => {
  it('parses a valid out_device direction', () => {
    const result = AdminStreamChatEventSchema.safeParse(VALID_CHAT_EVENT_OUT);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.direction).toBe('out_device');
    }
  });

  it('parses a valid in direction', () => {
    const result = AdminStreamChatEventSchema.safeParse({
      ...VALID_CHAT_EVENT_OUT,
      direction: 'in',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.direction).toBe('in');
    }
  });

  it('accepts null counterpartyE164 for group events', () => {
    const result = AdminStreamChatEventSchema.safeParse(VALID_CHAT_EVENT_IN_GROUP);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.counterpartyE164).toBeNull();
    }
  });
});

describe('AdminStreamChatEventSchema, history directions are rejected', () => {
  it('rejects direction: out_history', () => {
    const result = AdminStreamChatEventSchema.safeParse({
      ...VALID_CHAT_EVENT_OUT,
      direction: 'out_history',
    });
    expect(result.success).toBe(false);
  });

  it('rejects direction: in_history', () => {
    const result = AdminStreamChatEventSchema.safeParse({
      ...VALID_CHAT_EVENT_OUT,
      direction: 'in_history',
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AdminStreamMessageStatusSchema
// ---------------------------------------------------------------------------

describe('AdminStreamMessageStatusSchema, all valid statuses', () => {
  const STATUSES = ['queued', 'sent', 'delivered', 'read', 'failed'] as const;
  for (const status of STATUSES) {
    it(`parses status: ${status}`, () => {
      const result = AdminStreamMessageStatusSchema.safeParse({ ...VALID_STATUS, status });
      expect(result.success, `status '${status}' should be valid`).toBe(true);
    });
  }
});

describe('AdminStreamMessageStatusSchema, unknown status', () => {
  it('rejects an unknown status value', () => {
    const result = AdminStreamMessageStatusSchema.safeParse({ ...VALID_STATUS, status: 'expired' });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AdminStreamEventSchema, discriminated union
// ---------------------------------------------------------------------------

describe('AdminStreamEventSchema, discriminated union picks correct variant', () => {
  it('selects the inbound variant when kind is inbound', () => {
    const result = AdminStreamEventSchema.safeParse(VALID_INBOUND);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.kind).toBe('inbound');
    }
  });

  it('selects the chat_event variant when kind is chat_event', () => {
    const result = AdminStreamEventSchema.safeParse(VALID_CHAT_EVENT_OUT);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.kind).toBe('chat_event');
    }
  });

  it('selects the message_status variant when kind is message_status', () => {
    const result = AdminStreamEventSchema.safeParse(VALID_STATUS);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.kind).toBe('message_status');
    }
  });

  it('rejects a payload with no kind field', () => {
    const { kind: _omit, ...withoutKind } = VALID_INBOUND;
    const result = AdminStreamEventSchema.safeParse(withoutKind);
    expect(result.success).toBe(false);
  });

  it('rejects a payload with an unknown kind', () => {
    const result = AdminStreamEventSchema.safeParse({ ...VALID_INBOUND, kind: 'unknown_event' });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AdminStreamEnvelopeSchema
// ---------------------------------------------------------------------------

describe('AdminStreamEnvelopeSchema, valid envelope', () => {
  it('parses a well-formed envelope wrapping an inbound event', () => {
    const result = AdminStreamEnvelopeSchema.safeParse({
      at: ISO_TS,
      event: VALID_INBOUND,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.at).toBe(ISO_TS);
      expect(result.data.event.kind).toBe('inbound');
    }
  });

  it('parses a well-formed envelope wrapping a chat_event', () => {
    const result = AdminStreamEnvelopeSchema.safeParse({
      at: ISO_TS,
      event: VALID_CHAT_EVENT_OUT,
    });
    expect(result.success).toBe(true);
  });

  it('parses a well-formed envelope wrapping a message_status', () => {
    const result = AdminStreamEnvelopeSchema.safeParse({
      at: ISO_TS,
      event: VALID_STATUS,
    });
    expect(result.success).toBe(true);
  });
});

describe('AdminStreamEnvelopeSchema, invalid envelopes', () => {
  it('rejects a missing at field', () => {
    const result = AdminStreamEnvelopeSchema.safeParse({ event: VALID_INBOUND });
    expect(result.success).toBe(false);
  });

  it('rejects a non-ISO at value', () => {
    const result = AdminStreamEnvelopeSchema.safeParse({
      at: 'Tuesday',
      event: VALID_INBOUND,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a missing event field', () => {
    const result = AdminStreamEnvelopeSchema.safeParse({ at: ISO_TS });
    expect(result.success).toBe(false);
  });
});

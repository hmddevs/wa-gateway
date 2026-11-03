/**
 * Conversational-primitives schema tests (slice 1).
 *
 * Covers:
 *   - SendMessageRequestSchema with / without replyTo
 *   - ReactionRequestSchema emoji validation
 *   - PresenceRequestSchema state validation
 *   - InboundReactionEventSchema round-trip via WebhookEventSchema
 *   - Wire schemas: ReactCommandSchema, PresenceCommandSchema, ReactionEventSchema
 *   - SessionConversationConfigSchema default for sendReadReceipts
 */
import { describe, it, expect } from 'vitest';
import {
  SendMessageRequestSchema,
  ReactionRequestSchema,
  PresenceRequestSchema,
} from '../src/api.js';
import { WebhookEventSchema } from '../src/webhook.js';
import { ReactCommandSchema, PresenceCommandSchema, ReactionEventSchema } from '../src/wire.js';
import { SessionConversationConfigSchema } from '../src/db.js';

// ---------------------------------------------------------------------------
// SendMessageRequestSchema, replyTo
// ---------------------------------------------------------------------------

describe('SendMessageRequestSchema, replyTo', () => {
  it('accepts a valid request with replyTo populated', () => {
    const result = SendMessageRequestSchema.safeParse({
      to: '+447700900123',
      channel: 'transactional',
      purpose: 'transactional',
      body: { kind: 'text', text: 'Hello' },
      replyTo: { messageId: '00000000-0000-4000-8000-000000000001' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.replyTo?.messageId).toBe('00000000-0000-4000-8000-000000000001');
    }
  });

  it('accepts a valid request without replyTo', () => {
    const result = SendMessageRequestSchema.safeParse({
      to: '+447700900123',
      channel: 'transactional',
      purpose: 'transactional',
      body: { kind: 'text', text: 'Hello' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.replyTo).toBeUndefined();
    }
  });

  it('rejects replyTo where messageId is not a UUID', () => {
    const result = SendMessageRequestSchema.safeParse({
      to: '+447700900123',
      channel: 'transactional',
      purpose: 'transactional',
      body: { kind: 'text', text: 'Hello' },
      replyTo: { messageId: 'not-a-uuid' },
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ReactionRequestSchema
// ---------------------------------------------------------------------------

describe('ReactionRequestSchema, emoji validation', () => {
  it('accepts a thumbs-up emoji', () => {
    const result = ReactionRequestSchema.safeParse({ emoji: '👍' });
    expect(result.success).toBe(true);
  });

  it('accepts a party-popper emoji', () => {
    const result = ReactionRequestSchema.safeParse({ emoji: '🎉' });
    expect(result.success).toBe(true);
  });

  it('accepts the empty string (clear operation)', () => {
    const result = ReactionRequestSchema.safeParse({ emoji: '' });
    expect(result.success).toBe(true);
  });

  it('rejects a 9-character ASCII string', () => {
    // max is 8 characters
    const result = ReactionRequestSchema.safeParse({ emoji: 'abcdefghi' });
    expect(result.success).toBe(false);
  });

  it('rejects a non-emoji plain text string', () => {
    const result = ReactionRequestSchema.safeParse({ emoji: 'hello' });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PresenceRequestSchema
// ---------------------------------------------------------------------------

describe('PresenceRequestSchema, state validation', () => {
  const validStates = ['available', 'unavailable', 'composing', 'recording', 'paused'] as const;

  for (const state of validStates) {
    it(`accepts state "${state}"`, () => {
      const result = PresenceRequestSchema.safeParse({ state });
      expect(result.success).toBe(true);
    });
  }

  it('rejects an unknown state value', () => {
    const result = PresenceRequestSchema.safeParse({ state: 'unknown' });
    expect(result.success).toBe(false);
  });

  it('accepts state with optional to field', () => {
    const result = PresenceRequestSchema.safeParse({ state: 'composing', to: '+447700900123' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.to).toBe('+447700900123');
  });
});

// ---------------------------------------------------------------------------
// WebhookEventSchema, inbound.reaction round-trip
// ---------------------------------------------------------------------------

describe('WebhookEventSchema, inbound.reaction round-trip', () => {
  const base = {
    type: 'inbound.reaction' as const,
    at: new Date().toISOString(),
    eventId: '00000000-0000-4000-8000-000000000002',
    sessionId: 'test-session',
    waMessageId: 'wa-msg-abc-123',
    targetFromMe: true,
    from: '+447700900999',
    emoji: '👍',
  };

  it('parses a minimal inbound.reaction event without messageId', () => {
    const result = WebhookEventSchema.safeParse(base);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe('inbound.reaction');
      expect(result.data.messageId).toBeUndefined();
    }
  });

  it('parses an inbound.reaction event with optional messageId', () => {
    const withMessageId = {
      ...base,
      messageId: '00000000-0000-4000-8000-000000000003',
    };
    const result = WebhookEventSchema.safeParse(withMessageId);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe('inbound.reaction');
      // @ts-expect-error, narrowed union field present after type guard
      expect(result.data.messageId).toBe('00000000-0000-4000-8000-000000000003');
    }
  });

  it('rejects inbound.reaction with a non-UUID messageId', () => {
    const bad = { ...base, messageId: 'not-a-uuid' };
    const result = WebhookEventSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Wire schemas
// ---------------------------------------------------------------------------

const wireEnvelopeBase = {
  nonce: '00000000-0000-4000-8000-000000000010',
  at: new Date().toISOString(),
  sig: 'a'.repeat(64),
};

describe('ReactCommandSchema, parse', () => {
  it('parses a representative react command payload', () => {
    const result = ReactCommandSchema.safeParse({
      type: 'react',
      ...wireEnvelopeBase,
      messageId: '00000000-0000-4000-8000-000000000020',
      to: '+447700900123',
      waJid: '447700900123@s.whatsapp.net',
      targetWaMessageId: 'wa-target-001',
      targetFromMe: true,
      emoji: '👍',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe('react');
      expect(result.data.emoji).toBe('👍');
      expect(result.data.targetFromMe).toBe(true);
    }
  });

  it('rejects a react command with an emoji exceeding 8 chars', () => {
    const result = ReactCommandSchema.safeParse({
      type: 'react',
      ...wireEnvelopeBase,
      messageId: '00000000-0000-4000-8000-000000000020',
      to: '+447700900123',
      waJid: '447700900123@s.whatsapp.net',
      targetWaMessageId: 'wa-target-001',
      targetFromMe: true,
      emoji: 'toolongstring!',
    });
    expect(result.success).toBe(false);
  });
});

describe('PresenceCommandSchema, parse', () => {
  it('parses a presence command with waJid (chat-scoped)', () => {
    const result = PresenceCommandSchema.safeParse({
      type: 'presence',
      ...wireEnvelopeBase,
      state: 'composing',
      waJid: '447700900123@s.whatsapp.net',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.state).toBe('composing');
      expect(result.data.waJid).toBe('447700900123@s.whatsapp.net');
    }
  });

  it('parses a global presence command without waJid', () => {
    const result = PresenceCommandSchema.safeParse({
      type: 'presence',
      ...wireEnvelopeBase,
      state: 'unavailable',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.waJid).toBeUndefined();
    }
  });

  it('rejects an unknown presence state', () => {
    const result = PresenceCommandSchema.safeParse({
      type: 'presence',
      ...wireEnvelopeBase,
      state: 'idle',
    });
    expect(result.success).toBe(false);
  });
});

describe('ReactionEventSchema, parse', () => {
  it('parses a representative inbound reaction event from the worker', () => {
    const result = ReactionEventSchema.safeParse({
      type: 'reaction',
      ...wireEnvelopeBase,
      targetWaMessageId: 'wa-target-001',
      targetFromMe: false,
      from: '+447700900999',
      fromJid: '447700900999@s.whatsapp.net',
      emoji: '❤️',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe('reaction');
      expect(result.data.targetFromMe).toBe(false);
      expect(result.data.emoji).toBe('❤️');
    }
  });
});

// ---------------------------------------------------------------------------
// SessionConversationConfigSchema, defaults
// ---------------------------------------------------------------------------

describe('SessionConversationConfigSchema, sendReadReceipts default', () => {
  it('defaults sendReadReceipts to true when the field is absent', () => {
    const result = SessionConversationConfigSchema.parse({});
    expect(result.sendReadReceipts).toBe(true);
  });

  it('preserves an explicit sendReadReceipts: false', () => {
    const result = SessionConversationConfigSchema.parse({ sendReadReceipts: false });
    expect(result.sendReadReceipts).toBe(false);
  });

  it('preserves an explicit sendReadReceipts: true', () => {
    const result = SessionConversationConfigSchema.parse({ sendReadReceipts: true });
    expect(result.sendReadReceipts).toBe(true);
  });
});

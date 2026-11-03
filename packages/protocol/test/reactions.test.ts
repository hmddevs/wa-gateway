/**
 * Slice 4b, wire-schema round-trips for `MessageReactionDoc`,
 * `AdminThreadMessageReplyTo`, and `AdminThreadMessageReaction`.
 * Pure Zod parse checks; no I/O.
 */
import { describe, it, expect } from 'vitest';
import {
  MessageReactionDocSchema,
  AdminThreadMessageReplyToSchema,
  AdminThreadMessageReactionSchema,
  AdminThreadMessageSchema,
} from '../src/index.js';

const TS = '2026-05-10T12:00:00.000Z';
const SESSION_ID = 'session-1';
const WA_MESSAGE_ID = 'BAE5ABCDEF0123456789';
const MSG_UUID = '00000000-0000-4000-8000-000000000001';

// ---------------------------------------------------------------------------
// MessageReactionDocSchema
// ---------------------------------------------------------------------------

describe('MessageReactionDocSchema', () => {
  it('parses a populated outbound-target reaction with messageId resolved', () => {
    const doc = {
      sessionId: SESSION_ID,
      waMessageId: WA_MESSAGE_ID,
      messageId: MSG_UUID,
      targetFromMe: true,
      fromJid: '447700900000@s.whatsapp.net',
      fromE164: '+447700900000',
      emoji: '❤️',
      ts: TS,
      capturedAt: TS,
    };
    const result = MessageReactionDocSchema.safeParse(doc);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.messageId).toBe(MSG_UUID);
      expect(result.data.targetFromMe).toBe(true);
      expect(result.data.emoji).toBe('❤️');
    }
  });

  it('parses a cleared reaction (emoji is empty string, audit-only row)', () => {
    const doc = {
      sessionId: SESSION_ID,
      waMessageId: WA_MESSAGE_ID,
      targetFromMe: false,
      fromJid: '447700900001@s.whatsapp.net',
      fromE164: '+447700900001',
      emoji: '',
      ts: TS,
      capturedAt: TS,
    };
    const result = MessageReactionDocSchema.safeParse(doc);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.emoji).toBe('');
      expect(result.data.messageId).toBeUndefined();
    }
  });

  it('parses a group-reactor row with fromE164: null', () => {
    const doc = {
      sessionId: SESSION_ID,
      waMessageId: WA_MESSAGE_ID,
      targetFromMe: false,
      fromJid: '12036311111111@g.us',
      fromE164: null,
      emoji: '👍',
      ts: TS,
      capturedAt: TS,
    };
    const result = MessageReactionDocSchema.safeParse(doc);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.fromE164).toBeNull();
    }
  });

  it('rejects an emoji string longer than 8 chars', () => {
    const doc = {
      sessionId: SESSION_ID,
      waMessageId: WA_MESSAGE_ID,
      targetFromMe: false,
      fromJid: '447700900000@s.whatsapp.net',
      fromE164: '+447700900000',
      emoji: 'aaaaaaaaa',
      ts: TS,
      capturedAt: TS,
    };
    const result = MessageReactionDocSchema.safeParse(doc);
    expect(result.success).toBe(false);
  });

  it('rejects a malformed messageId (not a UUID)', () => {
    const doc = {
      sessionId: SESSION_ID,
      waMessageId: WA_MESSAGE_ID,
      messageId: 'not-a-uuid',
      targetFromMe: true,
      fromJid: '447700900000@s.whatsapp.net',
      fromE164: '+447700900000',
      emoji: '👍',
      ts: TS,
      capturedAt: TS,
    };
    const result = MessageReactionDocSchema.safeParse(doc);
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AdminThreadMessageReplyToSchema
// ---------------------------------------------------------------------------

describe('AdminThreadMessageReplyToSchema', () => {
  it('parses a complete replyTo with all fields', () => {
    const r = {
      messageId: MSG_UUID,
      waMessageId: WA_MESSAGE_ID,
      fromMe: true,
      bodyPreview: 'Hello, this is the original message',
    };
    const result = AdminThreadMessageReplyToSchema.safeParse(r);
    expect(result.success).toBe(true);
  });

  it('parses with messageId: null (original was inbound or never resolved)', () => {
    const r = {
      messageId: null,
      waMessageId: WA_MESSAGE_ID,
      fromMe: false,
    };
    const result = AdminThreadMessageReplyToSchema.safeParse(r);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.messageId).toBeNull();
      expect(result.data.bodyPreview).toBeUndefined();
    }
  });

  it('rejects a bodyPreview longer than 280 chars', () => {
    const r = {
      messageId: null,
      waMessageId: WA_MESSAGE_ID,
      fromMe: false,
      bodyPreview: 'x'.repeat(281),
    };
    const result = AdminThreadMessageReplyToSchema.safeParse(r);
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AdminThreadMessageReactionSchema
// ---------------------------------------------------------------------------

describe('AdminThreadMessageReactionSchema', () => {
  it('parses a populated reaction projection', () => {
    const r = {
      fromJid: '447700900000@s.whatsapp.net',
      fromE164: '+447700900000',
      emoji: '😃',
      ts: TS,
    };
    const result = AdminThreadMessageReactionSchema.safeParse(r);
    expect(result.success).toBe(true);
  });

  it('parses with fromE164: null (group reactor)', () => {
    const r = {
      fromJid: '12036311111111@g.us',
      fromE164: null,
      emoji: '👍',
      ts: TS,
    };
    const result = AdminThreadMessageReactionSchema.safeParse(r);
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AdminThreadMessageSchema, replyTo + reactions slots
// ---------------------------------------------------------------------------

describe('AdminThreadMessageSchema with replyTo + reactions', () => {
  it('parses a message carrying both replyTo and reactions', () => {
    const m = {
      messageId: MSG_UUID,
      direction: 'out' as const,
      ts: TS,
      body: { kind: 'text' as const, text: 'A reply' },
      replyTo: {
        messageId: '00000000-0000-4000-8000-00000000aaaa',
        waMessageId: 'BAE5OTHERWAID',
        fromMe: true,
        bodyPreview: 'The original',
      },
      reactions: [
        {
          fromJid: '447700900000@s.whatsapp.net',
          fromE164: '+447700900000',
          emoji: '👍',
          ts: TS,
        },
      ],
    };
    const result = AdminThreadMessageSchema.safeParse(m);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.replyTo?.bodyPreview).toBe('The original');
      expect(result.data.reactions).toHaveLength(1);
    }
  });

  it('parses a message with neither field set', () => {
    const m = {
      messageId: MSG_UUID,
      direction: 'in' as const,
      ts: TS,
      body: { kind: 'text' as const, text: 'No quotes, no reactions' },
    };
    const result = AdminThreadMessageSchema.safeParse(m);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.replyTo).toBeUndefined();
      expect(result.data.reactions).toBeUndefined();
    }
  });
});

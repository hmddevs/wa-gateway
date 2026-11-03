/**
 * Protocol schema round-trips, admin conversation viewer (slice A).
 *
 * Covers:
 *   - AdminMessageStatusSchema, every valid value; reject unknown
 *   - AdminThreadSummarySchema, happy path, optional field behaviour, invalid values
 *   - AdminThreadMessageSchema, every body kind, optional fields, direction constraints
 *   - AdminThreadsListResponseSchema, empty and populated, cursor variants
 *   - AdminThreadMessagesResponseSchema, empty and populated, cursor variants
 */
import { describe, it, expect } from 'vitest';
import {
  AdminMessageStatusSchema,
  AdminThreadSummarySchema,
  AdminThreadMessageSchema,
  AdminThreadsListResponseSchema,
  AdminThreadMessagesResponseSchema,
} from '../src/api.js';

// ---------------------------------------------------------------------------
// AdminMessageStatusSchema
// ---------------------------------------------------------------------------

describe('AdminMessageStatusSchema', () => {
  const validStatuses = [
    'queued',
    'scheduled',
    'sent',
    'delivered',
    'read',
    'failed',
    'expired',
  ] as const;

  validStatuses.forEach((status) => {
    it(`accepts the "${status}" status`, () => {
      expect(AdminMessageStatusSchema.parse(status)).toBe(status);
    });
  });

  it('rejects an unknown status value', () => {
    expect(() => AdminMessageStatusSchema.parse('pending')).toThrow();
  });

  it('rejects an empty string', () => {
    expect(() => AdminMessageStatusSchema.parse('')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// AdminThreadSummarySchema
// ---------------------------------------------------------------------------

describe('AdminThreadSummarySchema', () => {
  const base = {
    counterparty: '+447700900123',
    lastMessageAt: '2025-04-29T10:00:00.000Z',
    lastMessagePreview: 'Hello!',
    lastMessageDirection: 'out',
    lastMessageStatus: 'delivered',
    unreadCount: 0,
  };

  it('parses a valid outbound-last thread summary', () => {
    const result = AdminThreadSummarySchema.parse(base);
    expect(result.counterparty).toBe('+447700900123');
    expect(result.lastMessageDirection).toBe('out');
    expect(result.lastMessageStatus).toBe('delivered');
    expect(result.unreadCount).toBe(0);
  });

  it('allows lastMessageStatus to be absent when direction is "in"', () => {
    const { lastMessageStatus: _omit, ...rest } = base;
    const result = AdminThreadSummarySchema.parse({ ...rest, lastMessageDirection: 'in' });
    expect(result.lastMessageStatus).toBeUndefined();
  });

  it('allows lastMessageStatus to be absent even for direction "out" (field is optional)', () => {
    const { lastMessageStatus: _omit, ...rest } = base;
    const result = AdminThreadSummarySchema.parse(rest);
    expect(result.lastMessageStatus).toBeUndefined();
  });

  it('rejects an invalid lastMessageStatus value', () => {
    expect(() =>
      AdminThreadSummarySchema.parse({ ...base, lastMessageStatus: 'bounced' }),
    ).toThrow();
  });

  it('rejects an invalid direction value', () => {
    expect(() =>
      AdminThreadSummarySchema.parse({ ...base, lastMessageDirection: 'both' }),
    ).toThrow();
  });

  it('rejects a negative unreadCount', () => {
    expect(() => AdminThreadSummarySchema.parse({ ...base, unreadCount: -1 })).toThrow();
  });

  it('accepts a thread summary with a non-zero unreadCount', () => {
    const result = AdminThreadSummarySchema.parse({
      ...base,
      unreadCount: 5,
      lastMessageDirection: 'in',
    });
    expect(result.unreadCount).toBe(5);
  });

  it('rejects a lastMessagePreview exceeding 120 chars', () => {
    expect(() =>
      AdminThreadSummarySchema.parse({ ...base, lastMessagePreview: 'x'.repeat(121) }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// AdminThreadMessageSchema
// ---------------------------------------------------------------------------

describe('AdminThreadMessageSchema', () => {
  const baseOut = {
    messageId: 'msg-outbound-1',
    direction: 'out',
    ts: '2025-04-29T10:00:00.000Z',
    body: { kind: 'text', text: 'Hello world' },
    status: 'delivered',
  };

  const baseIn = {
    messageId: 'msg-inbound-1',
    direction: 'in',
    ts: '2025-04-29T10:01:00.000Z',
    body: { kind: 'text', text: 'Hi back' },
  };

  it('parses an outbound text message', () => {
    const result = AdminThreadMessageSchema.parse(baseOut);
    expect(result.direction).toBe('out');
    expect(result.status).toBe('delivered');
  });

  it('parses an inbound text message without status', () => {
    const result = AdminThreadMessageSchema.parse(baseIn);
    expect(result.direction).toBe('in');
    expect(result.status).toBeUndefined();
  });

  it('parses an image body with optional caption and mediaFileName', () => {
    const result = AdminThreadMessageSchema.parse({
      ...baseIn,
      body: { kind: 'image', caption: 'A photo', mediaFileName: 'photo.jpg' },
    });
    if (result.body.kind === 'image') {
      expect(result.body.caption).toBe('A photo');
      expect(result.body.mediaFileName).toBe('photo.jpg');
    }
  });

  it('parses an image body without optional fields', () => {
    const result = AdminThreadMessageSchema.parse({
      ...baseIn,
      body: { kind: 'image' },
    });
    expect(result.body.kind).toBe('image');
  });

  it('parses a document body', () => {
    const result = AdminThreadMessageSchema.parse({
      ...baseIn,
      body: { kind: 'document', caption: 'Invoice', mediaFileName: 'invoice.pdf' },
    });
    expect(result.body.kind).toBe('document');
  });

  it('parses an audio body', () => {
    const result = AdminThreadMessageSchema.parse({ ...baseIn, body: { kind: 'audio' } });
    expect(result.body.kind).toBe('audio');
  });

  it('parses a video body', () => {
    const result = AdminThreadMessageSchema.parse({ ...baseIn, body: { kind: 'video' } });
    expect(result.body.kind).toBe('video');
  });

  it('parses a sticker body', () => {
    const result = AdminThreadMessageSchema.parse({ ...baseIn, body: { kind: 'sticker' } });
    expect(result.body.kind).toBe('sticker');
  });

  it('parses an other body', () => {
    const result = AdminThreadMessageSchema.parse({ ...baseIn, body: { kind: 'other' } });
    expect(result.body.kind).toBe('other');
  });

  it('rejects an unknown body kind', () => {
    expect(() =>
      AdminThreadMessageSchema.parse({ ...baseIn, body: { kind: 'reaction' } }),
    ).toThrow();
  });

  it('rejects an invalid direction', () => {
    expect(() => AdminThreadMessageSchema.parse({ ...baseOut, direction: 'both' })).toThrow();
  });

  it('rejects a missing messageId', () => {
    const { messageId: _omit, ...rest } = baseOut;
    expect(() => AdminThreadMessageSchema.parse(rest)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// AdminThreadsListResponseSchema
// ---------------------------------------------------------------------------

describe('AdminThreadsListResponseSchema', () => {
  const summary = {
    counterparty: '+447700900123',
    lastMessageAt: '2025-04-29T10:00:00.000Z',
    lastMessagePreview: 'Hi',
    lastMessageDirection: 'in',
    unreadCount: 2,
  };

  it('parses an empty list with null cursor', () => {
    const result = AdminThreadsListResponseSchema.parse({ items: [], nextCursor: null });
    expect(result.items).toHaveLength(0);
    expect(result.nextCursor).toBeNull();
  });

  it('parses a populated list with null cursor', () => {
    const result = AdminThreadsListResponseSchema.parse({ items: [summary], nextCursor: null });
    expect(result.items).toHaveLength(1);
  });

  it('parses a populated list with a string cursor', () => {
    const result = AdminThreadsListResponseSchema.parse({
      items: [summary],
      nextCursor: 'eyJ0cyI6IjIwMjUtMDQtMjlUMTA6MDA6MDAuMDAwWiIsImlkIjoiYWJjIn0',
    });
    expect(typeof result.nextCursor).toBe('string');
  });

  it('rejects a missing nextCursor field', () => {
    expect(() => AdminThreadsListResponseSchema.parse({ items: [] })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// AdminThreadMessagesResponseSchema
// ---------------------------------------------------------------------------

describe('AdminThreadMessagesResponseSchema', () => {
  const message = {
    messageId: 'msg-1',
    direction: 'out',
    ts: '2025-04-29T10:00:00.000Z',
    body: { kind: 'text', text: 'Hello' },
    status: 'sent',
  };

  it('parses an empty message list with null cursor', () => {
    const result = AdminThreadMessagesResponseSchema.parse({ items: [], nextCursor: null });
    expect(result.items).toHaveLength(0);
    expect(result.nextCursor).toBeNull();
  });

  it('parses a populated message list with null cursor', () => {
    const result = AdminThreadMessagesResponseSchema.parse({
      items: [message],
      nextCursor: null,
    });
    expect(result.items).toHaveLength(1);
  });

  it('parses a populated list with a string cursor', () => {
    const result = AdminThreadMessagesResponseSchema.parse({
      items: [message],
      nextCursor: 'someOpaqueBase64Cursor',
    });
    expect(typeof result.nextCursor).toBe('string');
  });

  it('parses mixed-direction items in the same response', () => {
    const inMessage = {
      messageId: 'msg-2',
      direction: 'in',
      ts: '2025-04-29T10:01:00.000Z',
      body: { kind: 'text', text: 'Reply' },
    };
    const result = AdminThreadMessagesResponseSchema.parse({
      items: [message, inMessage],
      nextCursor: null,
    });
    expect(result.items[0].direction).toBe('out');
    expect(result.items[1].direction).toBe('in');
    expect(result.items[1].status).toBeUndefined();
  });

  it('rejects a missing nextCursor field', () => {
    expect(() => AdminThreadMessagesResponseSchema.parse({ items: [] })).toThrow();
  });
});

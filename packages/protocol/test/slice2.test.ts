/**
 * Slice 2 schema tests, protocol package.
 *
 * Covers:
 *   - OptOutSchema round-trip
 *   - SendMessageRequestSchema, sendAt accepted
 *   - ContactOptedOutEventSchema round-trip
 *   - ErrorCodes, all slice-2 codes present
 */
import { describe, it, expect } from 'vitest';
import { OptOutSchema } from '../src/db.js';
import { SendMessageRequestSchema } from '../src/api.js';
import { ContactOptedOutEventSchema } from '../src/webhook.js';
import { ErrorCodes } from '../src/errors.js';

// ---------------------------------------------------------------------------
// OptOutSchema
// ---------------------------------------------------------------------------

describe('OptOutSchema, round-trip', () => {
  it('parses a keyword opt-out document', () => {
    const result = OptOutSchema.safeParse({
      sessionId: 'session-a',
      phone: '+447700900123',
      source: 'keyword',
      keyword: 'STOP',
      createdAt: new Date(),
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.source).toBe('keyword');
      expect(result.data.keyword).toBe('STOP');
    }
  });

  it('parses an admin opt-out document without keyword field', () => {
    const result = OptOutSchema.safeParse({
      sessionId: 'session-a',
      phone: '+447700900123',
      source: 'admin',
      createdAt: new Date(),
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.source).toBe('admin');
      expect(result.data.keyword).toBeUndefined();
    }
  });

  it('rejects an invalid phone number', () => {
    const result = OptOutSchema.safeParse({
      sessionId: 'session-a',
      phone: 'not-a-phone',
      source: 'admin',
      createdAt: new Date(),
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown source value', () => {
    const result = OptOutSchema.safeParse({
      sessionId: 'session-a',
      phone: '+447700900123',
      source: 'user',
      createdAt: new Date(),
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SendMessageRequestSchema, sendAt
// ---------------------------------------------------------------------------

describe('SendMessageRequestSchema, sendAt', () => {
  const base = {
    to: '+447700900123',
    channel: 'transactional',
    purpose: 'transactional',
    body: { kind: 'text', text: 'Hello' },
  };

  it('accepts a valid future sendAt ISO string', () => {
    const sendAt = new Date(Date.now() + 60_000).toISOString();
    const result = SendMessageRequestSchema.safeParse({ ...base, sendAt });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sendAt).toBe(sendAt);
    }
  });

  it('accepts the schema without sendAt (immediate send)', () => {
    const result = SendMessageRequestSchema.safeParse(base);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sendAt).toBeUndefined();
    }
  });

  it('rejects a non-ISO string as sendAt', () => {
    const result = SendMessageRequestSchema.safeParse({ ...base, sendAt: 'tomorrow' });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ContactOptedOutEventSchema
// ---------------------------------------------------------------------------

describe('ContactOptedOutEventSchema, round-trip', () => {
  const base = {
    type: 'contact.opted_out' as const,
    at: new Date().toISOString(),
    eventId: '00000000-0000-4000-8000-000000000002',
    sessionId: 'session-a',
    phone: '+447700900123',
    source: 'keyword' as const,
    keyword: 'STOP',
  };

  it('parses a valid keyword opt-out event', () => {
    const result = ContactOptedOutEventSchema.safeParse(base);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe('contact.opted_out');
      expect(result.data.source).toBe('keyword');
      expect(result.data.keyword).toBe('STOP');
    }
  });

  it('parses an admin opt-out event without keyword', () => {
    const { keyword: _k, ...adminBase } = base;
    const result = ContactOptedOutEventSchema.safeParse({ ...adminBase, source: 'admin' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.source).toBe('admin');
    }
  });

  it('rejects an event with a non-E.164 phone', () => {
    const result = ContactOptedOutEventSchema.safeParse({ ...base, phone: '07700900123' });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ErrorCodes, slice 2 codes present
// ---------------------------------------------------------------------------

describe('ErrorCodes, slice 2 codes', () => {
  it('defines OPTED_OUT', () => {
    expect(ErrorCodes.OPTED_OUT).toBeTruthy();
  });

  it('defines SEND_AT_PAST', () => {
    expect(ErrorCodes.SEND_AT_PAST).toBeTruthy();
  });
});

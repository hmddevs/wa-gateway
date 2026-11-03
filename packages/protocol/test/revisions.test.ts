/**
 * Slice 1, wire-schema round-trips for the message-revision and contact
 * schemas added in `db.ts` and `wire.ts`, plus the history-sync batch
 * header. Pure Zod parse checks; no I/O.
 */
import { describe, it, expect } from 'vitest';
import {
  MessageRevisionDocSchema,
  ContactDocSchema,
  MessageRevisionEventSchema,
  ContactEventSchema,
  HistorySyncBatchHeaderSchema,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const TS = '2026-05-10T12:00:00.000Z';
const SESSION_ID = 'session-1';
const MESSAGE_ID = '00000000-0000-4000-8000-000000000001';

const WA_MESSAGE_ID = 'BAE5ABCDEF0123456789';

const REVISION_EDIT = {
  sessionId: SESSION_ID,
  messageId: MESSAGE_ID,
  waMessageId: WA_MESSAGE_ID,
  revisionSeq: 1,
  kind: 'edit' as const,
  body: { kind: 'text' as const, text: 'Edited body' },
  ts: TS,
  capturedAt: TS,
  source: 'live' as const,
};

const REVISION_DELETE = {
  sessionId: SESSION_ID,
  messageId: MESSAGE_ID,
  waMessageId: WA_MESSAGE_ID,
  revisionSeq: 2,
  kind: 'delete' as const,
  deletedBy: 'sender' as const,
  ts: TS,
  capturedAt: TS,
  source: 'live' as const,
};

const CONTACT_FULL = {
  sessionId: SESSION_ID,
  e164: '+447700900000',
  waJid: '447700900000@s.whatsapp.net',
  displayName: 'Alice',
  pushName: 'Alice A.',
  profilePictureUrl: 'https://cdn.example.com/avatar.jpg',
  isBusiness: false,
  lastSeenAt: TS,
  capturedAt: TS,
  source: 'live' as const,
};

const CONTACT_MIN = {
  sessionId: SESSION_ID,
  e164: '+447700900001',
  waJid: '447700900001@s.whatsapp.net',
  isBusiness: false,
  capturedAt: TS,
  source: 'history' as const,
};

// ---------------------------------------------------------------------------
// MessageRevisionDocSchema, kind/body/deletedBy refinement
// ---------------------------------------------------------------------------

describe('MessageRevisionDocSchema, edit', () => {
  it('parses a valid edit revision (body present, deletedBy absent)', () => {
    const result = MessageRevisionDocSchema.safeParse(REVISION_EDIT);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.kind).toBe('edit');
      expect(result.data.body).toEqual({ kind: 'text', text: 'Edited body' });
    }
  });

  it('rejects edit without body', () => {
    const { body: _omit, ...withoutBody } = REVISION_EDIT;
    const result = MessageRevisionDocSchema.safeParse(withoutBody);
    expect(result.success).toBe(false);
  });
});

describe('MessageRevisionDocSchema, delete', () => {
  it('parses a valid delete revision (body absent, deletedBy present)', () => {
    const result = MessageRevisionDocSchema.safeParse(REVISION_DELETE);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.kind).toBe('delete');
      expect(result.data.deletedBy).toBe('sender');
    }
  });

  it('rejects delete with body present', () => {
    const result = MessageRevisionDocSchema.safeParse({
      ...REVISION_DELETE,
      body: { kind: 'text', text: 'should not be here' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects delete without deletedBy', () => {
    const { deletedBy: _omit, ...withoutDeletedBy } = REVISION_DELETE;
    const result = MessageRevisionDocSchema.safeParse(withoutDeletedBy);
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ContactDocSchema
// ---------------------------------------------------------------------------

describe('ContactDocSchema', () => {
  it('parses a fully-populated contact', () => {
    const result = ContactDocSchema.safeParse(CONTACT_FULL);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.displayName).toBe('Alice');
      expect(result.data.profilePictureUrl).toBe('https://cdn.example.com/avatar.jpg');
    }
  });

  it('parses a minimal contact (only required fields)', () => {
    const result = ContactDocSchema.safeParse(CONTACT_MIN);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.displayName).toBeUndefined();
      expect(result.data.lastSeenAt).toBeUndefined();
    }
  });

  it('rejects a malformed e164', () => {
    const result = ContactDocSchema.safeParse({ ...CONTACT_FULL, e164: '07700900000' });
    expect(result.success).toBe(false);
  });

  it('rejects a malformed profilePictureUrl', () => {
    const result = ContactDocSchema.safeParse({
      ...CONTACT_FULL,
      profilePictureUrl: 'not a url',
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// MessageRevisionEventSchema (wire), discriminator type: 'message_revision'
// ---------------------------------------------------------------------------

describe('MessageRevisionDocSchema, nullable messageId', () => {
  it('parses a row with messageId: null (revision arrived before original)', () => {
    const result = MessageRevisionDocSchema.safeParse({
      ...REVISION_EDIT,
      messageId: null,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.messageId).toBeNull();
      expect(result.data.waMessageId).toBe(WA_MESSAGE_ID);
    }
  });

  it('rejects a row missing waMessageId', () => {
    const { waMessageId: _omit, ...withoutWa } = REVISION_EDIT;
    const result = MessageRevisionDocSchema.safeParse(withoutWa);
    expect(result.success).toBe(false);
  });
});

describe('MessageRevisionEventSchema', () => {
  // why: wire-side carries `waMessageId` not `messageId`, the gateway
  // resolves the UUID at insert time. DB-side keeps `messageId` (nullable).

  it('parses a valid message_revision edit wire event', () => {
    const wire = {
      type: 'message_revision' as const,
      sessionId: SESSION_ID,
      waMessageId: WA_MESSAGE_ID,
      revisionSeq: 1,
      kind: 'edit' as const,
      body: { kind: 'text' as const, text: 'Edited' },
      ts: TS,
      source: 'live' as const,
    };
    const result = MessageRevisionEventSchema.safeParse(wire);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe('message_revision');
      expect(result.data.kind).toBe('edit');
      expect(result.data.waMessageId).toBe(WA_MESSAGE_ID);
    }
  });

  it("rejects a payload claiming kind 'edit' but missing body", () => {
    const wire = {
      type: 'message_revision' as const,
      sessionId: SESSION_ID,
      waMessageId: WA_MESSAGE_ID,
      revisionSeq: 1,
      kind: 'edit' as const,
      ts: TS,
      source: 'live' as const,
    };
    const result = MessageRevisionEventSchema.safeParse(wire);
    expect(result.success).toBe(false);
  });

  it('rejects a wire payload that still carries messageId instead of waMessageId', () => {
    const wire = {
      type: 'message_revision' as const,
      sessionId: SESSION_ID,
      messageId: MESSAGE_ID,
      revisionSeq: 1,
      kind: 'edit' as const,
      body: { kind: 'text' as const, text: 'Edited' },
      ts: TS,
      source: 'live' as const,
    };
    const result = MessageRevisionEventSchema.safeParse(wire);
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ContactEventSchema (wire)
// ---------------------------------------------------------------------------

describe('ContactEventSchema', () => {
  it('parses a valid contact wire event', () => {
    const wire = {
      type: 'contact' as const,
      sessionId: SESSION_ID,
      e164: '+447700900000',
      waJid: '447700900000@s.whatsapp.net',
      displayName: 'Alice',
      isBusiness: false,
      source: 'live' as const,
    };
    const result = ContactEventSchema.safeParse(wire);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe('contact');
      expect(result.data.displayName).toBe('Alice');
    }
  });

  it('rejects a contact wire event with the wrong type literal', () => {
    const wire = {
      type: 'contact' as const,
      sessionId: SESSION_ID,
      e164: '+447700900000',
      waJid: '447700900000@s.whatsapp.net',
      isBusiness: 'no', // wrong type for the field
      source: 'live' as const,
    };
    const result = ContactEventSchema.safeParse(wire);
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// HistorySyncBatchHeaderSchema
// ---------------------------------------------------------------------------

describe('HistorySyncBatchHeaderSchema', () => {
  it('parses a valid header (with batchTotal)', () => {
    const header = {
      historySync: true as const,
      sessionId: SESSION_ID,
      batchIndex: 0,
      batchTotal: 12,
    };
    const result = HistorySyncBatchHeaderSchema.safeParse(header);
    expect(result.success).toBe(true);
  });

  it('parses a valid header without batchTotal', () => {
    const header = {
      historySync: true as const,
      sessionId: SESSION_ID,
      batchIndex: 3,
    };
    const result = HistorySyncBatchHeaderSchema.safeParse(header);
    expect(result.success).toBe(true);
  });

  it('rejects historySync: false', () => {
    const header = {
      historySync: false,
      sessionId: SESSION_ID,
      batchIndex: 0,
    };
    const result = HistorySyncBatchHeaderSchema.safeParse(header);
    expect(result.success).toBe(false);
  });

  it('rejects negative batchIndex', () => {
    const header = {
      historySync: true as const,
      sessionId: SESSION_ID,
      batchIndex: -1,
    };
    const result = HistorySyncBatchHeaderSchema.safeParse(header);
    expect(result.success).toBe(false);
  });
});

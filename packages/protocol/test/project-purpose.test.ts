/**
 * Project/purpose metadata schema tests.
 *
 * Covers the protocol surface across db.ts, api.ts, and wire.ts:
 *
 *   - ProjectIdSchema, lowercase kebab slug, 1–64 chars
 *   - MessagePurposeSchema, seven-value enum
 *   - SendMessageRequestSchema, requires `purpose`
 *   - SendCommandSchema (wire), requires `projectId` and `purpose`
 *   - ApiKeySchema, requires `projectId`
 *   - MessageSchema, requires `projectId` and `purpose`
 */
import { describe, it, expect } from 'vitest';
import { ProjectIdSchema, MessagePurposeSchema, ApiKeySchema, MessageSchema } from '../src/db.js';
import { SendMessageRequestSchema } from '../src/api.js';
import { SendCommandSchema } from '../src/wire.js';

// ---------------------------------------------------------------------------
// ProjectIdSchema
// ---------------------------------------------------------------------------

describe('ProjectIdSchema, accepts valid slugs', () => {
  const valid = ['acme', 'example-service', 'a', 'a1', 'admin-console'];

  for (const slug of valid) {
    it(`accepts '${slug}'`, () => {
      expect(ProjectIdSchema.safeParse(slug).success).toBe(true);
    });
  }
});

describe('ProjectIdSchema, rejects invalid slugs', () => {
  it('rejects an empty string', () => {
    expect(ProjectIdSchema.safeParse('').success).toBe(false);
  });

  it('rejects a slug that starts with a hyphen', () => {
    expect(ProjectIdSchema.safeParse('-foo').success).toBe(false);
  });

  it('rejects a slug that ends with a hyphen', () => {
    expect(ProjectIdSchema.safeParse('foo-').success).toBe(false);
  });

  it('rejects uppercase characters', () => {
    expect(ProjectIdSchema.safeParse('Foo').success).toBe(false);
  });

  it('rejects underscores', () => {
    expect(ProjectIdSchema.safeParse('foo_bar').success).toBe(false);
  });

  it('rejects leading whitespace', () => {
    expect(ProjectIdSchema.safeParse(' foo').success).toBe(false);
  });

  it('rejects a 65-character string (one over the limit)', () => {
    const tooLong = 'a'.repeat(65);
    expect(ProjectIdSchema.safeParse(tooLong).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// MessagePurposeSchema
// ---------------------------------------------------------------------------

describe('MessagePurposeSchema, accepts all valid values', () => {
  const valid = [
    'otp',
    'magic_link',
    'transactional',
    'notification',
    'support',
    'marketing',
    'other',
  ] as const;

  for (const value of valid) {
    it(`accepts '${value}'`, () => {
      expect(MessagePurposeSchema.safeParse(value).success).toBe(true);
    });
  }
});

describe('MessagePurposeSchema, rejects invalid values', () => {
  it("rejects an unknown value like 'spam'", () => {
    expect(MessagePurposeSchema.safeParse('spam').success).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(MessagePurposeSchema.safeParse('').success).toBe(false);
  });

  it('rejects null', () => {
    expect(MessagePurposeSchema.safeParse(null).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SendMessageRequestSchema, purpose
// ---------------------------------------------------------------------------

describe('SendMessageRequestSchema, purpose field', () => {
  const baseRequest = {
    to: '+447700900123',
    body: { kind: 'text' as const, text: 'Hello' },
  };

  it("rejects a payload missing 'purpose' (Required-style error)", () => {
    const result = SendMessageRequestSchema.safeParse(baseRequest);
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'));
      expect(paths).toContain('purpose');
    }
  });

  it('accepts a minimal valid payload with purpose', () => {
    const result = SendMessageRequestSchema.safeParse({
      ...baseRequest,
      purpose: 'otp',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.purpose).toBe('otp');
    }
  });
});

// ---------------------------------------------------------------------------
// SendCommandSchema (wire), projectId / purpose
// ---------------------------------------------------------------------------

describe('SendCommandSchema, projectId required', () => {
  const baseSendCmd = {
    type: 'send' as const,
    nonce: '00000000-0000-4000-8000-000000000001',
    at: '2026-05-10T12:00:00.000Z',
    sig: 'a'.repeat(64),
    messageId: '00000000-0000-4000-8000-000000000002',
    to: '+447700900123',
    waJid: '447700900123@s.whatsapp.net',
    category: 'transactional' as const,
    purpose: 'otp' as const,
    content: { type: 'text' as const, text: 'Hi' },
    attempt: 0,
  };

  it('rejects a command missing projectId', () => {
    const result = SendCommandSchema.safeParse(baseSendCmd);
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'));
      expect(paths).toContain('projectId');
    }
  });

  it('accepts a valid send envelope', () => {
    const result = SendCommandSchema.safeParse({
      ...baseSendCmd,
      projectId: 'example-service',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.projectId).toBe('example-service');
      expect(result.data.purpose).toBe('otp');
    }
  });
});

// ---------------------------------------------------------------------------
// ApiKeySchema, projectId required
// ---------------------------------------------------------------------------

describe('ApiKeySchema, projectId required', () => {
  const baseApiKey = {
    keyId: 'key_test',
    keyHash: '$argon2id$v=19$m=65536,t=3,p=4$fakehash',
    keyLookupHash: 'a'.repeat(64),
    division: 'hmd',
    label: 'Test Key',
    scopes: ['send:transactional'],
    rateLimit: { perMinute: 60, perHour: 1000, perDay: 10000 },
    ipAllowlist: null,
    environment: 'test' as const,
    createdAt: new Date(),
    createdBy: 'admin@hmd.test',
    lastUsedAt: null,
    lastUsedIp: null,
    lastUsedUserAgent: null,
    revokedAt: null,
    revokedBy: null,
    revokedReason: null,
  };

  it('rejects an ApiKey missing projectId', () => {
    const result = ApiKeySchema.safeParse(baseApiKey);
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'));
      expect(paths).toContain('projectId');
    }
  });

  it('accepts a valid ApiKey with projectId', () => {
    const result = ApiKeySchema.safeParse({ ...baseApiKey, projectId: 'acme' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.projectId).toBe('acme');
    }
  });
});

// ---------------------------------------------------------------------------
// MessageSchema, projectId and purpose required
// ---------------------------------------------------------------------------

describe('MessageSchema, projectId and purpose required', () => {
  const baseMessage = {
    messageId: '00000000-0000-4000-8000-000000000003',
    apiKeyId: 'key_abc',
    division: 'hmd',
    category: 'transactional' as const,
    to: '+447700900123',
    toHash: 'b'.repeat(64),
    waJid: '447700900123@s.whatsapp.net',
    content: { type: 'text' as const, text: 'Hi' },
    status: 'queued' as const,
    statusHistory: [{ status: 'queued' as const, at: new Date() }],
    waMessageId: null,
    attempts: 0,
    maxAttempts: 3,
    ttlExpiresAt: new Date(Date.now() + 60_000),
    webhookUrl: null,
    webhookDeliveredAt: null,
    webhookAttempts: 0,
    idempotencyKey: null,
    requestIp: '1.2.3.4',
    requestUserAgent: 'test',
    createdAt: new Date(),
    scheduledFor: null,
    dispatchedAt: null,
    sentAt: null,
    deliveredAt: null,
    readAt: null,
  };

  it('rejects a MessageDoc missing projectId', () => {
    const result = MessageSchema.safeParse({ ...baseMessage, purpose: 'otp' });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'));
      expect(paths).toContain('projectId');
    }
  });

  it('rejects a MessageDoc missing purpose', () => {
    const result = MessageSchema.safeParse({ ...baseMessage, projectId: 'acme' });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'));
      expect(paths).toContain('purpose');
    }
  });

  it('accepts a valid MessageDoc with projectId and purpose', () => {
    const result = MessageSchema.safeParse({
      ...baseMessage,
      projectId: 'acme',
      purpose: 'otp',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.projectId).toBe('acme');
      expect(result.data.purpose).toBe('otp');
    }
  });
});

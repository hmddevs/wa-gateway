/**
 * Sync-confirm send schema tests.
 *
 * Covers the protocol surface added for opt-in synchronous confirmation on
 * `POST /v1/messages` (`confirm: true`):
 *
 *   - SendMessageRequestSchema accepts the new `confirm` /
 *     `confirmTimeoutMs` fields, including the documented bounds
 *     (300 .. 30000 ms inclusive).
 *   - SendMessageResponseSchema round-trips the widened `status` enum
 *     (`'queued' | 'scheduled' | 'sent' | 'failed'`) and the new
 *     `errorCode` field.
 *   - SendAckEnvelopeSchema (worker → gateway, Redis pub/sub on
 *     `wa:ack:<messageId>`) round-trips both terminal states and rejects
 *     malformed envelopes.
 */
import { describe, it, expect } from 'vitest';
import { SendMessageRequestSchema, SendMessageResponseSchema } from '../src/api.js';
import { SendAckEnvelopeSchema } from '../src/wire.js';

// ---------------------------------------------------------------------------
// SendMessageRequestSchema, confirm / confirmTimeoutMs
// ---------------------------------------------------------------------------

describe('SendMessageRequestSchema, confirm / confirmTimeoutMs', () => {
  const baseRequest = {
    to: '+447700900123',
    channel: 'transactional' as const,
    purpose: 'transactional' as const,
    body: { kind: 'text' as const, text: 'Hello' },
  };

  it('accepts confirm and confirmTimeoutMs together', () => {
    const result = SendMessageRequestSchema.safeParse({
      ...baseRequest,
      confirm: true,
      confirmTimeoutMs: 5000,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.confirm).toBe(true);
      expect(result.data.confirmTimeoutMs).toBe(5000);
    }
  });

  it('accepts confirm without confirmTimeoutMs (default applied gateway-side)', () => {
    const result = SendMessageRequestSchema.safeParse({
      ...baseRequest,
      confirm: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.confirm).toBe(true);
      expect(result.data.confirmTimeoutMs).toBeUndefined();
    }
  });

  it('accepts confirm: false (explicit opt-out)', () => {
    const result = SendMessageRequestSchema.safeParse({
      ...baseRequest,
      confirm: false,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.confirm).toBe(false);
    }
  });

  it('accepts confirmTimeoutMs at the lower bound (300)', () => {
    const result = SendMessageRequestSchema.safeParse({
      ...baseRequest,
      confirm: true,
      confirmTimeoutMs: 300,
    });
    expect(result.success).toBe(true);
  });

  it('rejects confirmTimeoutMs below the lower bound (299)', () => {
    const result = SendMessageRequestSchema.safeParse({
      ...baseRequest,
      confirm: true,
      confirmTimeoutMs: 299,
    });
    expect(result.success).toBe(false);
  });

  it('accepts confirmTimeoutMs at the upper bound (30000)', () => {
    const result = SendMessageRequestSchema.safeParse({
      ...baseRequest,
      confirm: true,
      confirmTimeoutMs: 30_000,
    });
    expect(result.success).toBe(true);
  });

  it('rejects confirmTimeoutMs above the upper bound (30001)', () => {
    const result = SendMessageRequestSchema.safeParse({
      ...baseRequest,
      confirm: true,
      confirmTimeoutMs: 30_001,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-integer confirmTimeoutMs', () => {
    const result = SendMessageRequestSchema.safeParse({
      ...baseRequest,
      confirm: true,
      confirmTimeoutMs: 5_000.5,
    });
    expect(result.success).toBe(false);
  });

  it('parses cleanly without either confirm field (back-compat)', () => {
    const result = SendMessageRequestSchema.safeParse(baseRequest);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.confirm).toBeUndefined();
      expect(result.data.confirmTimeoutMs).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// SendMessageResponseSchema, widened status enum + errorCode
// ---------------------------------------------------------------------------

describe('SendMessageResponseSchema, widened status / errorCode', () => {
  const messageId = '00000000-0000-4000-8000-000000000001';

  it("round-trips the default async-path 'queued' shape", () => {
    const payload = { messageId, status: 'queued' as const };
    const result = SendMessageResponseSchema.safeParse(payload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe('queued');
      expect(result.data.errorCode).toBeUndefined();
      expect(result.data.requestId).toBeUndefined();
    }
  });

  it("round-trips the confirm-mode 'sent' shape (no errorCode)", () => {
    const payload = {
      messageId,
      status: 'sent' as const,
      requestId: 'req-abc-123',
    };
    const result = SendMessageResponseSchema.safeParse(payload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe('sent');
      expect(result.data.errorCode).toBeUndefined();
      expect(result.data.requestId).toBe('req-abc-123');
    }
  });

  it("round-trips the confirm-mode 'failed' shape with errorCode", () => {
    const payload = {
      messageId,
      status: 'failed' as const,
      errorCode: 'WORKER_UNAVAILABLE',
      requestId: 'req-abc-124',
    };
    const result = SendMessageResponseSchema.safeParse(payload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe('failed');
      expect(result.data.errorCode).toBe('WORKER_UNAVAILABLE');
    }
  });

  it("round-trips an idempotent-replay short-circuit shape ('sent' + idempotent: true)", () => {
    const payload = {
      messageId,
      status: 'sent' as const,
      idempotent: true,
      requestId: 'req-abc-125',
    };
    const result = SendMessageResponseSchema.safeParse(payload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.idempotent).toBe(true);
    }
  });

  it("round-trips the 'scheduled' shape (existing async-path field)", () => {
    const payload = { messageId, status: 'scheduled' as const };
    const result = SendMessageResponseSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it('accepts the full DB status union, async-path idempotent replay returns MessageDoc.status verbatim', () => {
    for (const status of ['delivered', 'read', 'expired'] as const) {
      const payload = { messageId, status };
      const result = SendMessageResponseSchema.safeParse(payload);
      expect(result.success).toBe(true);
    }
  });

  it('rejects a value outside the DB status union', () => {
    const payload = { messageId, status: 'wibble' };
    const result = SendMessageResponseSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it('rejects a non-UUID messageId', () => {
    const payload = { messageId: 'not-a-uuid', status: 'sent' };
    const result = SendMessageResponseSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SendAckEnvelopeSchema, worker → gateway Redis envelope
// ---------------------------------------------------------------------------

describe('SendAckEnvelopeSchema, worker → gateway envelope', () => {
  const messageId = '00000000-0000-4000-8000-000000000010';
  const ts = '2026-05-05T12:34:56.000Z';

  it("round-trips a 'sent' envelope with waMessageId", () => {
    const payload = {
      messageId,
      status: 'sent' as const,
      waMessageId: '3EB0ABCDEF1234567890',
      ts,
    };
    const result = SendAckEnvelopeSchema.safeParse(payload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe('sent');
      expect(result.data.waMessageId).toBe('3EB0ABCDEF1234567890');
      expect(result.data.errorCode).toBeUndefined();
    }
  });

  it("round-trips a 'failed' envelope with errorCode", () => {
    const payload = {
      messageId,
      status: 'failed' as const,
      errorCode: 'BAILEYS_TIMEOUT',
      ts,
    };
    const result = SendAckEnvelopeSchema.safeParse(payload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe('failed');
      expect(result.data.errorCode).toBe('BAILEYS_TIMEOUT');
      expect(result.data.waMessageId).toBeUndefined();
    }
  });

  it("rejects status: 'queued' (terminal-only channel)", () => {
    const payload = { messageId, status: 'queued', ts };
    const result = SendAckEnvelopeSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it("rejects status: 'delivered' (delivered/read flow via ReceiptEvent, not this channel)", () => {
    const payload = { messageId, status: 'delivered', ts };
    const result = SendAckEnvelopeSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it('rejects a non-UUID messageId', () => {
    const payload = { messageId: 'not-a-uuid', status: 'sent', ts };
    const result = SendAckEnvelopeSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it('rejects a malformed ts (missing offset)', () => {
    const payload = { messageId, status: 'sent', ts: '2026-05-05 12:34:56' };
    const result = SendAckEnvelopeSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it('rejects a missing ts', () => {
    const payload = { messageId, status: 'sent' };
    const result = SendAckEnvelopeSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });
});

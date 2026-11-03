/**
 * Rate limiter over ioredis MULTI (INCRBY + EXPIRE). Asserts the single
 * pipelined round-trip, the cap semantics (count <= limit), the multi-unit
 * history-sync charge, and fail-closed behaviour on a Redis anomaly.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/env', () => ({
  env: { RATE_LIMIT_IP_PER_MIN: 1200 },
}));

const multiState: { incrResult: number; execOverride?: unknown } = { incrResult: 1 };

function makeMulti() {
  const chain = {
    incr: vi.fn(() => chain),
    incrby: vi.fn(() => chain),
    expire: vi.fn(() => chain),
    exec: vi.fn(async () =>
      multiState.execOverride !== undefined
        ? multiState.execOverride
        : [
            [null, multiState.incrResult],
            [null, 1],
          ],
    ),
  };
  return chain;
}

let lastMulti: ReturnType<typeof makeMulti>;
vi.mock('@/lib/redis', () => ({
  getRedis: vi.fn(() => ({
    multi: () => {
      lastMulti = makeMulti();
      return lastMulti;
    },
  })),
}));

import {
  checkGlobal,
  checkIp,
  checkApiKey,
  checkHistorySyncBatch,
  checkRecipient,
} from '../rate-limit';

beforeEach(() => {
  multiState.incrResult = 1;
  multiState.execOverride = undefined;
});

describe('charge semantics', () => {
  it('checkIp allows when count is within the cap', async () => {
    multiState.incrResult = 1200;
    expect(await checkIp('203.0.113.7')).toBe(true);
  });

  it('checkIp rejects when count exceeds the cap (1200)', async () => {
    multiState.incrResult = 1201;
    expect(await checkIp('203.0.113.7')).toBe(false);
  });

  it('uses a single pipelined MULTI: INCRBY then EXPIRE', async () => {
    await checkGlobal();
    expect(lastMulti.incrby).toHaveBeenCalledTimes(1);
    expect(lastMulti.expire).toHaveBeenCalledTimes(1);
    expect(lastMulti.exec).toHaveBeenCalledTimes(1);
    // INCRBY cost is 1 for the simple tiers.
    expect(lastMulti.incrby).toHaveBeenCalledWith(expect.any(String), 1);
    expect(lastMulti.expire).toHaveBeenCalledWith(expect.any(String), 60);
  });

  it('checkGlobal rejects above 10000', async () => {
    multiState.incrResult = 10_001;
    expect(await checkGlobal()).toBe(false);
  });

  it('checkApiKey honours the per-key cap', async () => {
    multiState.incrResult = 60;
    expect(await checkApiKey('k1', 60)).toBe(true);
    multiState.incrResult = 61;
    expect(await checkApiKey('k1', 60)).toBe(false);
  });
});

describe('checkHistorySyncBatch, multi-unit charge', () => {
  it('charges the batch count to INCRBY', async () => {
    multiState.incrResult = 500;
    await checkHistorySyncBatch('sess-1', 500);
    expect(lastMulti.incrby).toHaveBeenCalledWith(expect.any(String), 500);
  });

  it('rejects when the 5000/min cap is breached', async () => {
    multiState.incrResult = 5001;
    expect(await checkHistorySyncBatch('sess-1', 500)).toBe(false);
  });

  it('short-circuits empty sessionId', async () => {
    expect(await checkHistorySyncBatch('', 10)).toBe(true);
  });
});

describe('checkRecipient, per-recipient OTP-bomb cap', () => {
  it('passes while at/under the cap (5)', async () => {
    multiState.incrResult = 5;
    expect(await checkRecipient('+447700900123')).toBe(true);
  });

  it('blocks once the cap is breached', async () => {
    multiState.incrResult = 6;
    expect(await checkRecipient('+447700900123')).toBe(false);
  });

  it('uses INCR + EXPIRE in one MULTI on the recipient key', async () => {
    multiState.incrResult = 1;
    await checkRecipient('+447700900123');
    expect(lastMulti.incr).toHaveBeenCalledWith('wa:rl:recipient:+447700900123');
    expect(lastMulti.expire).toHaveBeenCalledWith('wa:rl:recipient:+447700900123', 600);
  });
});

describe('fail-closed', () => {
  it('rejects when exec returns null (MULTI discarded)', async () => {
    multiState.execOverride = null;
    expect(await checkIp('203.0.113.7')).toBe(false);
  });

  it('rejects when the INCRBY tuple carries an error', async () => {
    multiState.execOverride = [
      [new Error('boom'), null],
      [null, 1],
    ];
    expect(await checkIp('203.0.113.7')).toBe(false);
  });
});

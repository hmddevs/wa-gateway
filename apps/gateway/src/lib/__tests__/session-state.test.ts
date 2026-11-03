/**
 * Developed by HMD Developments
 * For HMD WA Gateway
 * www.hmddevs.org
 */
/**
 * Warm-up ramp and budget reservation.
 *
 * The ramp is the part that has to be right retroactively: every session that
 * predates this change has no `warmupStartedAt`, and treating those as "day 0"
 * would throttle production numbers to 10% overnight.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const redis = {
  multi: vi.fn(),
  get: vi.fn(),
  set: vi.fn(),
};
vi.mock('@/lib/redis', () => ({ getRedis: () => redis }));

import { DEFAULT_BUDGET, effectiveBudget, reserveSend } from '@/lib/session-state';
import type { SessionDoc } from '@/lib/repositories/sessions';

function session(overrides: Partial<SessionDoc> = {}): SessionDoc {
  return { sessionId: 'org-a-01', ...overrides } as SessionDoc;
}

const daysAgo = (n: number): Date => new Date(Date.now() - n * 86_400_000);

/** Build an ioredis-style MULTI whose exec() returns the given INCR counts. */
function multiReturning(counts: number[]): void {
  const chain = { incr: vi.fn(), expire: vi.fn(), decr: vi.fn(), exec: vi.fn() };
  chain.incr.mockReturnValue(chain);
  chain.expire.mockReturnValue(chain);
  chain.decr.mockReturnValue(chain);
  // One [err, value] pair per queued command, interleaved incr/expire.
  chain.exec.mockResolvedValue(
    counts.flatMap((c) => [
      [null, c],
      [null, 1],
    ]),
  );
  redis.multi.mockReturnValue(chain);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('effectiveBudget, warm-up ramp', () => {
  it('treats a session with no warmupStartedAt as fully warmed', () => {
    // Every session predating this change lands here. Ramping them would
    // silently cut production capacity to a tenth.
    expect(effectiveBudget(session())).toEqual(DEFAULT_BUDGET);
  });

  it('starts a brand-new number at the floor, not at zero', () => {
    const b = effectiveBudget(session({ warmupStartedAt: new Date() }));
    expect(b.perHour).toBe(Math.floor(DEFAULT_BUDGET.perHour * 0.1));
    // A floor of zero would make a freshly paired number permanently
    // ineligible rather than merely slow.
    expect(b.perMinute).toBeGreaterThan(0);
  });

  it('ramps up partway through the window', () => {
    const b = effectiveBudget(session({ warmupStartedAt: daysAgo(7) }));
    expect(b.perHour).toBe(Math.floor(DEFAULT_BUDGET.perHour * 0.5));
  });

  it('reaches the full configured budget once the ramp completes', () => {
    expect(effectiveBudget(session({ warmupStartedAt: daysAgo(14) }))).toEqual(DEFAULT_BUDGET);
    expect(effectiveBudget(session({ warmupStartedAt: daysAgo(400) }))).toEqual(DEFAULT_BUDGET);
  });

  it("ramps the session's own configured budget, not the defaults", () => {
    const budget = { perMinute: 100, perHour: 1_000, perDay: 10_000 };
    const b = effectiveBudget(session({ budget, warmupStartedAt: daysAgo(7) }));
    expect(b.perHour).toBe(500);
  });
});

describe('reserveSend', () => {
  it('charges all three windows and accepts when every one has room', async () => {
    multiReturning([5, 50, 500]);
    await expect(reserveSend('org-a-01', DEFAULT_BUDGET)).resolves.toBe(true);
  });

  it('rejects and refunds when any single window is over cap', async () => {
    // Minute and day are fine; the hour bucket is one past its cap. All three
    // must have room, so this is a rejection.
    multiReturning([5, DEFAULT_BUDGET.perHour + 1, 500]);
    await expect(reserveSend('org-a-01', DEFAULT_BUDGET)).resolves.toBe(false);
    // Two MULTIs: the charge, then the refund that undoes it.
    expect(redis.multi).toHaveBeenCalledTimes(2);
  });

  it('fails closed on an unreadable reply rather than assuming headroom', async () => {
    const chain = { incr: vi.fn(), expire: vi.fn(), decr: vi.fn(), exec: vi.fn() };
    chain.incr.mockReturnValue(chain);
    chain.expire.mockReturnValue(chain);
    chain.decr.mockReturnValue(chain);
    chain.exec.mockResolvedValue(null);
    redis.multi.mockReturnValue(chain);

    await expect(reserveSend('org-a-01', DEFAULT_BUDGET)).resolves.toBe(false);
  });
});

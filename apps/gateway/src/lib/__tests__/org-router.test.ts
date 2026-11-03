/**
 * Developed by HMD Developments
 * For HMD WA Gateway
 * www.hmddevs.org
 */
/**
 * Organization router, eligibility, affinity, strategy, reservation.
 *
 * The case that matters most is the one the old session-pool picker got wrong:
 * a number that is socket-connected and heartbeating normally but has been
 * throttled by WhatsApp. Liveness alone says it is fine; budget and health are
 * what take it out of rotation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/repositories/organizations', () => ({ getOrg: vi.fn() }));
vi.mock('@/lib/repositories/sessions', () => ({ getCachedSession: vi.fn() }));
vi.mock('@/lib/session-state', () => ({
  HEALTH_MIN: 40,
  effectiveBudget: vi.fn(() => ({ perMinute: 20, perHour: 500, perDay: 5000 })),
  getAffinity: vi.fn().mockResolvedValue(null),
  getHealth: vi.fn().mockResolvedValue(100),
  nextRotation: vi.fn().mockResolvedValue(0),
  remainingHourly: vi.fn().mockResolvedValue(100),
  reserveSend: vi.fn().mockResolvedValue(true),
  setAffinity: vi.fn().mockResolvedValue(undefined),
}));

import { routeSend } from '@/lib/org-router';
import { getOrg } from '@/lib/repositories/organizations';
import { getCachedSession } from '@/lib/repositories/sessions';
import {
  getAffinity,
  getHealth,
  remainingHourly,
  reserveSend,
  setAffinity,
} from '@/lib/session-state';
import type { SessionDoc } from '@/lib/repositories/sessions';

const mockGetOrg = getOrg as ReturnType<typeof vi.fn>;
const mockGetCachedSession = getCachedSession as ReturnType<typeof vi.fn>;
const mockGetAffinity = getAffinity as ReturnType<typeof vi.fn>;
const mockGetHealth = getHealth as ReturnType<typeof vi.fn>;
const mockRemainingHourly = remainingHourly as ReturnType<typeof vi.fn>;
const mockReserveSend = reserveSend as ReturnType<typeof vi.fn>;
const mockSetAffinity = setAffinity as ReturnType<typeof vi.fn>;

const TO = '+447700900003';

function session(sessionId: string, overrides: Partial<SessionDoc> = {}): SessionDoc {
  return {
    sessionId,
    workerId: 'worker-1',
    label: sessionId,
    status: 'connected',
    phoneE164: '+447700900004',
    pairing: null,
    version: null,
    lastHeartbeatAt: new Date(),
    connectedAt: new Date(),
    createdBy: 'admin@test.com',
    createdAt: new Date(),
    stoppedAt: null,
    ...overrides,
  } as SessionDoc;
}

/** Wire an organization whose members resolve to the given session docs. */
function org(sessions: SessionDoc[], strategy = 'weighted'): void {
  mockGetOrg.mockResolvedValue({
    orgId: 'org-a',
    label: 'ORG-A',
    sessions: sessions.map((s) => s.sessionId),
    strategy,
    createdAt: new Date(),
  });
  mockGetCachedSession.mockImplementation(
    async (id: string) => sessions.find((s) => s.sessionId === id) ?? null,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAffinity.mockResolvedValue(null);
  mockGetHealth.mockResolvedValue(100);
  mockRemainingHourly.mockResolvedValue(100);
  mockReserveSend.mockResolvedValue(true);
  mockSetAffinity.mockResolvedValue(undefined);
});

describe('routeSend, eligibility', () => {
  it('reports no_sessions for an unknown or empty organization', async () => {
    mockGetOrg.mockResolvedValue(null);
    expect(await routeSend('org-a', TO)).toEqual({ ok: false, reason: 'no_sessions' });

    mockGetOrg.mockResolvedValue({ orgId: 'org-a', sessions: [], strategy: 'weighted' });
    expect(await routeSend('org-a', TO)).toEqual({ ok: false, reason: 'no_sessions' });
  });

  it('skips a number whose heartbeat is stale even though status says connected', async () => {
    // A hard-crashed worker cannot update its own status, so `connected` is
    // stale and the heartbeat is the only evidence of the crash.
    org([
      session('org-a-01', { lastHeartbeatAt: new Date(Date.now() - 120_000) }),
      session('org-a-02'),
    ]);

    const res = await routeSend('org-a', TO);
    expect(res).toEqual({ ok: true, session: expect.objectContaining({ sessionId: 'org-a-02' }) });
  });

  it('skips a paused number', async () => {
    org([session('org-a-01', { paused: true }), session('org-a-02')]);

    const res = await routeSend('org-a', TO);
    expect(res.ok && res.session.sessionId).toBe('org-a-02');
  });

  it('skips a throttled number that is still connected and heartbeating', async () => {
    // The regression the whole router exists for: WhatsApp restricts the
    // number, the socket stays open, and only the health score knows.
    org([session('org-a-01'), session('org-a-02')]);
    mockGetHealth.mockImplementation(async (id: string) => (id === 'org-a-01' ? 20 : 100));

    const res = await routeSend('org-a', TO);
    expect(res.ok && res.session.sessionId).toBe('org-a-02');
    // The unhealthy number is never even charged.
    expect(mockReserveSend).not.toHaveBeenCalledWith('org-a-01', expect.anything());
  });

  it('reports no_healthy when every number is down, and never charges budget', async () => {
    org([session('org-a-01', { status: 'offline' })]);

    expect(await routeSend('org-a', TO)).toEqual({ ok: false, reason: 'no_healthy' });
    expect(mockReserveSend).not.toHaveBeenCalled();
  });
});

describe('routeSend, reservation', () => {
  it('falls through to the next number when a reservation loses its race', async () => {
    org([session('org-a-01'), session('org-a-02')], 'priority');
    mockReserveSend.mockImplementation(async (id: string) => id !== 'org-a-01');

    const res = await routeSend('org-a', TO);
    expect(res.ok && res.session.sessionId).toBe('org-a-02');
  });

  it('reports all_exhausted when every live number is out of budget', async () => {
    org([session('org-a-01'), session('org-a-02')]);
    mockReserveSend.mockResolvedValue(false);

    // Distinct from no_healthy: the numbers are fine, the organization is at
    // its send limit, and the caller should back off rather than alarm.
    expect(await routeSend('org-a', TO)).toEqual({ ok: false, reason: 'all_exhausted' });
  });
});

describe('routeSend, affinity', () => {
  it('prefers the number that last messaged this recipient', async () => {
    org([session('org-a-01'), session('org-a-02'), session('org-a-03')], 'priority');
    mockGetAffinity.mockResolvedValue('org-a-03');

    const res = await routeSend('org-a', TO);
    // Without the pin, `priority` would have taken org-a-01.
    expect(res.ok && res.session.sessionId).toBe('org-a-03');
  });

  it('ignores a pin to a number that is no longer eligible, and re-pins', async () => {
    org([session('org-a-01'), session('org-a-02', { status: 'offline' })], 'priority');
    mockGetAffinity.mockResolvedValue('org-a-02');

    const res = await routeSend('org-a', TO);
    expect(res.ok && res.session.sessionId).toBe('org-a-01');
    expect(mockSetAffinity).toHaveBeenCalledWith('org-a', TO, 'org-a-01');
  });

  it('skips affinity entirely when there is no recipient to pin', async () => {
    org([session('org-a-01')]);

    await routeSend('org-a', null);
    expect(mockGetAffinity).not.toHaveBeenCalled();
    expect(mockSetAffinity).not.toHaveBeenCalled();
  });
});

describe('routeSend, strategy', () => {
  it('priority walks the organization list in order', async () => {
    org([session('org-a-01'), session('org-a-02')], 'priority');

    const res = await routeSend('org-a', TO);
    expect(res.ok && res.session.sessionId).toBe('org-a-01');
  });

  it('round-robin advances with the rotation counter', async () => {
    const { nextRotation } = await import('@/lib/session-state');
    org([session('org-a-01'), session('org-a-02'), session('org-a-03')], 'round-robin');
    (nextRotation as ReturnType<typeof vi.fn>).mockResolvedValue(1);

    const res = await routeSend('org-a', TO);
    expect(res.ok && res.session.sessionId).toBe('org-a-02');
  });

  it('weighted spreads across numbers instead of pinning the first', async () => {
    org([session('org-a-01'), session('org-a-02')]);
    // Give org-a-02 overwhelmingly more headroom; over many draws it must win
    // the majority, which "first healthy" could never do.
    mockRemainingHourly.mockImplementation(async (id: string) => (id === 'org-a-01' ? 1 : 999));

    const picks: string[] = [];
    for (let i = 0; i < 40; i += 1) {
      const res = await routeSend('org-a', null);
      if (res.ok) picks.push(res.session.sessionId);
    }

    // Overwhelming but not absolute: the near-empty number takes almost all of
    // it, which "first healthy in list order" could never do. Asserting that
    // org-a-01 also appears would be a coin-flip on a 1-in-500 draw, so the
    // fallback chain is covered by the reservation test instead.
    expect(picks.filter((p) => p === 'org-a-02').length).toBeGreaterThan(30);
  });
});

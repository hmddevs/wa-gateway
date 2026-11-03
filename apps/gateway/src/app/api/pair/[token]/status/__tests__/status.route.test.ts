/**
 * GET /api/pair/:token/status, unauthenticated pairing-link view.
 *
 * Two things matter here and both are security properties, not cosmetics:
 * the route must never distinguish a malformed token from an unknown one, and
 * it must disclose only what the link's holder already owns, organization
 * label, and per number its id, state and last four digits. The token travels
 * in a URL and may be forwarded, so a full phone number or a worker id
 * leaking through this endpoint would be a real disclosure.
 *
 * Mocked boundaries: rate-limit, pairing-invite, the invite and session
 * repositories, and organizations. `getClientIp` is stubbed (its
 * spoof-resistance is covered by auth-api.test.ts; the real module drags in
 * the env-validated dependency chain for no benefit). `mintRequestId` is left
 * real, pure helper, no I/O.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/rate-limit', () => ({
  checkIp: vi.fn().mockResolvedValue(true),
}));

vi.mock('@/lib/pairing-invite', () => ({
  verifyInvite: vi.fn(),
}));

vi.mock('@/lib/repositories/pairing-invites', () => ({
  markInviteExpired: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/repositories/sessions', () => ({
  getSession: vi.fn(),
}));

vi.mock('@/lib/repositories/organizations', () => ({
  getOrg: vi.fn(),
}));

vi.mock('@/lib/auth-api', () => ({
  getClientIp: vi.fn().mockReturnValue('203.0.113.7'),
}));

import { GET } from '@/app/api/pair/[token]/status/route';
import type { PairViewBody } from '@/app/api/pair/[token]/status/route';
import { checkIp } from '@/lib/rate-limit';
import { verifyInvite } from '@/lib/pairing-invite';
import { markInviteExpired } from '@/lib/repositories/pairing-invites';
import { getSession } from '@/lib/repositories/sessions';
import { getOrg } from '@/lib/repositories/organizations';
import type { PairingInviteDoc } from '@/lib/repositories/pairing-invites';
import type { SessionDoc } from '@/lib/repositories/sessions';

const mockCheckIp = checkIp as ReturnType<typeof vi.fn>;
const mockVerifyInvite = verifyInvite as ReturnType<typeof vi.fn>;
const mockMarkInviteExpired = markInviteExpired as ReturnType<typeof vi.fn>;
const mockGetSession = getSession as ReturnType<typeof vi.fn>;
const mockGetOrg = getOrg as ReturnType<typeof vi.fn>;

function makeInvite(overrides: Partial<PairingInviteDoc> = {}): PairingInviteDoc {
  return {
    inviteId: 'pi_test-1',
    orgId: 'org-a',
    workerId: 'worker-1',
    lookupHash: 'h',
    tokenHash: 't',
    createdBy: 'admin@hmd.test',
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 60 * 60 * 1_000),
    status: 'active',
    maxSessions: 5,
    sessionIds: [],
    ...overrides,
  };
}

function makeSession(sessionId: string, overrides: Partial<SessionDoc> = {}): SessionDoc {
  return {
    sessionId,
    workerId: 'worker-1',
    label: sessionId,
    status: 'connected',
    phoneE164: '+447700900002',
    pairing: null,
    version: null,
    lastHeartbeatAt: new Date(),
    connectedAt: new Date(),
    createdBy: 'admin@hmd.test',
    createdAt: new Date(),
    stoppedAt: null,
    ...overrides,
  } as SessionDoc;
}

const call = async (): Promise<Response> =>
  GET(new Request('https://wa.test/api/pair/tok/status'), {
    params: Promise.resolve({ token: 'tok' }),
  });

const body = async (res: Response): Promise<PairViewBody> => (await res.json()) as PairViewBody;

beforeEach(() => {
  vi.clearAllMocks();
  mockCheckIp.mockResolvedValue(true);
  mockGetOrg.mockResolvedValue({ orgId: 'org-a', label: 'Acme Co', sessions: [] });
});

describe('guards', () => {
  it('429s when the IP bucket is exhausted, before any lookup', async () => {
    mockCheckIp.mockResolvedValue(false);

    const res = await call();

    expect(res.status).toBe(429);
    expect(mockVerifyInvite).not.toHaveBeenCalled();
  });

  it('404s identically for an unknown token, no existence oracle', async () => {
    mockVerifyInvite.mockResolvedValue(null);

    const res = await call();

    expect(res.status).toBe(404);
  });
});

describe('terminal link states', () => {
  it('reports revoked without listing any numbers', async () => {
    mockVerifyInvite.mockResolvedValue(makeInvite({ status: 'revoked', sessionIds: ['org-a-01'] }));

    const b = await body(await call());

    expect(b.status).toBe('revoked');
    expect(b.numbers).toEqual([]);
    expect(mockGetSession).not.toHaveBeenCalled();
  });

  it('expires lazily on read when expiresAt has passed', async () => {
    mockVerifyInvite.mockResolvedValue(makeInvite({ expiresAt: new Date(Date.now() - 1_000) }));

    const b = await body(await call());

    expect(b.status).toBe('expired');
    expect(mockMarkInviteExpired).toHaveBeenCalledWith('pi_test-1');
  });
});

describe('active link', () => {
  it('exposes the last four digits only, never the full number', async () => {
    mockVerifyInvite.mockResolvedValue(makeInvite({ sessionIds: ['org-a-01'] }));
    mockGetSession.mockResolvedValue(makeSession('org-a-01'));

    const b = await body(await call());

    expect(b.orgLabel).toBe('Acme Co');
    expect(b.numbers).toEqual([{ sessionId: 'org-a-01', state: 'connected', last4: '0002' }]);
    // The whole response, serialised, the full E.164 must appear nowhere in it.
    expect(JSON.stringify(b)).not.toContain('+447700900002');
  });

  it('returns a QR only while a number is still pairing', async () => {
    mockVerifyInvite.mockResolvedValue(makeInvite({ sessionIds: ['org-a-01', 'org-a-02'] }));
    mockGetSession.mockImplementation(async (id: string) =>
      id === 'org-a-01'
        ? makeSession('org-a-01')
        : makeSession('org-a-02', {
            status: 'pairing',
            phoneE164: null,
            pairing: { event: 'qr', qr: 'BASE64PNG', at: new Date() },
          }),
    );

    const b = await body(await call());

    expect(b.numbers[0]).toEqual({ sessionId: 'org-a-01', state: 'connected', last4: '0002' });
    // Raw base64 gets the data: prefix the <img> needs.
    expect(b.numbers[1]).toEqual({
      sessionId: 'org-a-02',
      state: 'pairing',
      last4: null,
      qrDataUrl: 'data:image/png;base64,BASE64PNG',
    });
  });

  it('passes an already-prefixed data URL through unchanged', async () => {
    mockVerifyInvite.mockResolvedValue(makeInvite({ sessionIds: ['org-a-01'] }));
    mockGetSession.mockResolvedValue(
      makeSession('org-a-01', {
        status: 'pairing',
        phoneE164: null,
        pairing: { event: 'qr', qr: 'data:image/png;base64,ALREADY', at: new Date() },
      }),
    );

    const b = await body(await call());

    expect(b.numbers[0]!.qrDataUrl).toBe('data:image/png;base64,ALREADY');
  });

  it('drops a number whose session was deleted rather than rendering a ghost', async () => {
    mockVerifyInvite.mockResolvedValue(makeInvite({ sessionIds: ['org-a-01', 'gone'] }));
    mockGetSession.mockImplementation(async (id: string) =>
      id === 'org-a-01' ? makeSession('org-a-01') : null,
    );

    const b = await body(await call());

    expect(b.numbers.map((n) => n.sessionId)).toEqual(['org-a-01']);
  });

  it('falls back to the orgId when the organization has no label', async () => {
    mockVerifyInvite.mockResolvedValue(makeInvite());
    mockGetOrg.mockResolvedValue(null);

    expect((await body(await call())).orgLabel).toBe('org-a');
  });
});

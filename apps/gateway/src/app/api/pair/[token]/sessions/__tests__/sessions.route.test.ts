/**
 * Developed by HMD Developments
 * For HMD WA Gateway
 * www.hmddevs.org
 */
/**
 * POST /api/pair/:token/sessions, adding a number through a pairing link.
 *
 * The branch worth protecting is the rollback: the session is provisioned
 * before the cap is claimed, so losing the race for the last slot must undo
 * the provisioning. Leaving the number attached would let a link add more
 * numbers than it was authorised to, quietly widening who can send as that
 * organization.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/rate-limit', () => ({ checkIp: vi.fn().mockResolvedValue(true) }));
vi.mock('@/lib/pairing-invite', () => ({ verifyInvite: vi.fn() }));
vi.mock('@/lib/repositories/pairing-invites', () => ({
  markInviteExpired: vi.fn().mockResolvedValue(undefined),
  recordInviteSession: vi.fn(),
}));
vi.mock('@/lib/session-provisioning', () => ({ provisionOrgNumber: vi.fn() }));
vi.mock('@/lib/repositories/sessions', () => ({
  deleteSession: vi.fn().mockResolvedValue(true),
  invalidateSessionCache: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/repositories/organizations', () => ({
  removeSession: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/lib/auth-api', () => ({ getClientIp: vi.fn().mockReturnValue('203.0.113.7') }));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { POST } from '@/app/api/pair/[token]/sessions/route';
import { checkIp } from '@/lib/rate-limit';
import { verifyInvite } from '@/lib/pairing-invite';
import { recordInviteSession } from '@/lib/repositories/pairing-invites';
import { provisionOrgNumber } from '@/lib/session-provisioning';
import { deleteSession } from '@/lib/repositories/sessions';
import { removeSession } from '@/lib/repositories/organizations';
import type { PairingInviteDoc } from '@/lib/repositories/pairing-invites';

const mockCheckIp = checkIp as ReturnType<typeof vi.fn>;
const mockVerifyInvite = verifyInvite as ReturnType<typeof vi.fn>;
const mockRecord = recordInviteSession as ReturnType<typeof vi.fn>;
const mockProvision = provisionOrgNumber as ReturnType<typeof vi.fn>;
const mockDeleteSession = deleteSession as ReturnType<typeof vi.fn>;
const mockRemoveFromOrg = removeSession as ReturnType<typeof vi.fn>;

function makeInvite(overrides: Partial<PairingInviteDoc> = {}): PairingInviteDoc {
  return {
    inviteId: 'pi_1',
    orgId: 'org-a',
    workerId: 'worker-1',
    lookupHash: 'h',
    tokenHash: 't',
    createdBy: 'admin@hmd.test',
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 3_600_000),
    status: 'active',
    maxSessions: 3,
    sessionIds: [],
    ...overrides,
  };
}

const call = async (): Promise<Response> =>
  POST(new Request('https://wa.test/api/pair/tok/sessions', { method: 'POST' }), {
    params: Promise.resolve({ token: 'tok' }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  mockCheckIp.mockResolvedValue(true);
  mockProvision.mockResolvedValue({ sessionId: 'org-a-01' });
  mockRecord.mockResolvedValue({ sessionIds: ['org-a-01'], maxSessions: 3 });
});

describe('guards', () => {
  it('404s for an unknown token without provisioning anything', async () => {
    mockVerifyInvite.mockResolvedValue(null);

    expect((await call()).status).toBe(404);
    expect(mockProvision).not.toHaveBeenCalled();
  });

  it('410s a revoked link', async () => {
    mockVerifyInvite.mockResolvedValue(makeInvite({ status: 'revoked' }));

    expect((await call()).status).toBe(410);
    expect(mockProvision).not.toHaveBeenCalled();
  });

  it('410s an expired link', async () => {
    mockVerifyInvite.mockResolvedValue(makeInvite({ expiresAt: new Date(Date.now() - 1) }));

    expect((await call()).status).toBe(410);
    expect(mockProvision).not.toHaveBeenCalled();
  });

  it('409s a full link without provisioning', async () => {
    mockVerifyInvite.mockResolvedValue(
      makeInvite({ maxSessions: 2, sessionIds: ['org-a-01', 'org-a-02'] }),
    );

    expect((await call()).status).toBe(409);
    expect(mockProvision).not.toHaveBeenCalled();
  });
});

describe('adding a number', () => {
  it('provisions under the invite organization and reports usage', async () => {
    mockVerifyInvite.mockResolvedValue(makeInvite());

    const res = await call();

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ sessionId: 'org-a-01', used: 1, max: 3 });
    expect(mockProvision).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 'org-a', workerId: 'worker-1' }),
    );
  });

  it('rolls the session back when the last slot is taken mid-flight', async () => {
    mockVerifyInvite.mockResolvedValue(makeInvite());
    // The pre-check passed, but a concurrent caller filled the link before
    // this one recorded its session.
    mockRecord.mockResolvedValue(null);

    const res = await call();

    expect(res.status).toBe(409);
    // Both halves of the undo must run: detached from the organization AND
    // the session document removed.
    expect(mockRemoveFromOrg).toHaveBeenCalledWith('org-a', 'org-a-01');
    expect(mockDeleteSession).toHaveBeenCalledWith('org-a-01');
  });
});

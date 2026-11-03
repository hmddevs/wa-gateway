/**
 * pairing-invite.ts, issue/verify round trip and failure modes.
 *
 * Mocks `./repositories/pairing-invites` (findInviteByLookupHash) and `./env`
 * (fixed SERVER_PEPPER so HMAC output is deterministic across runs). Uses the
 * real `argon2` and `node:crypto`, these are the exact primitives under test,
 * mocking them would defeat the point.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/repositories/pairing-invites', () => ({
  findInviteByLookupHash: vi.fn(),
}));

vi.mock('@/lib/env', () => ({
  env: { SERVER_PEPPER: Buffer.alloc(32, 7).toString('base64') },
}));

import { issueInvite, verifyInvite } from '@/lib/pairing-invite';
import { findInviteByLookupHash } from '@/lib/repositories/pairing-invites';
import type { PairingInviteDoc } from '@/lib/repositories/pairing-invites';

const mockFindInviteByLookupHash = findInviteByLookupHash as ReturnType<typeof vi.fn>;

function makeDoc(overrides: Partial<PairingInviteDoc> = {}): PairingInviteDoc {
  return {
    inviteId: 'pi_test-1',
    orgId: 'org-a',
    workerId: 'worker-1',
    lookupHash: 'unused-in-these-tests',
    tokenHash: 'unused-in-these-tests',
    createdBy: 'admin@hmd.test',
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 60 * 60 * 1_000),
    status: 'active',
    maxSessions: 5,
    sessionIds: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('issueInvite / verifyInvite, round trip', () => {
  it('verifies successfully when the lookup returns the matching doc', async () => {
    const issued = await issueInvite();
    expect(issued.plaintext.startsWith('hmd_pi_')).toBe(true);

    const doc = makeDoc({ lookupHash: issued.lookupHash, tokenHash: issued.tokenHash });
    mockFindInviteByLookupHash.mockResolvedValue(doc);

    const result = await verifyInvite(issued.plaintext);

    expect(result).toEqual(doc);
    expect(mockFindInviteByLookupHash).toHaveBeenCalledWith(issued.lookupHash);
  });
});

describe('verifyInvite, malformed token', () => {
  it('returns null for a token missing the hmd_pi_ prefix', async () => {
    const result = await verifyInvite('hmd_sk_someothersecretvalueheretoolong1234567890');
    expect(result).toBeNull();
    expect(mockFindInviteByLookupHash).not.toHaveBeenCalled();
  });

  it('returns null for a correctly-prefixed but too-short body', async () => {
    const result = await verifyInvite('hmd_pi_short');
    expect(result).toBeNull();
    expect(mockFindInviteByLookupHash).not.toHaveBeenCalled();
  });

  it('returns null for a body containing invalid base64url characters', async () => {
    // 43 chars but with a '+' which base64url does not permit.
    const invalidBody = `${'a'.repeat(42)}+`;
    const result = await verifyInvite(`hmd_pi_${invalidBody}`);
    expect(result).toBeNull();
    expect(mockFindInviteByLookupHash).not.toHaveBeenCalled();
  });

  it('never throws on non-string input', async () => {
    await expect(verifyInvite(undefined as unknown as string)).resolves.toBeNull();
  });
});

describe('verifyInvite, unknown token', () => {
  it('returns null when findInviteByLookupHash finds no matching row', async () => {
    const issued = await issueInvite();
    mockFindInviteByLookupHash.mockResolvedValue(null);

    const result = await verifyInvite(issued.plaintext);

    expect(result).toBeNull();
  });
});

describe('verifyInvite, wrong secret against a valid-format token', () => {
  it('returns null when the doc found is a different invite (argon2 mismatch)', async () => {
    // Two distinct issued tokens; simulate the lookup returning the WRONG
    // doc's hash relative to the token being verified (e.g. a lookup-hash
    // collision scenario or a bug upstream), argon2.verify must reject it.
    const issuedA = await issueInvite();
    const issuedB = await issueInvite();
    const docForB = makeDoc({ lookupHash: issuedB.lookupHash, tokenHash: issuedB.tokenHash });

    // Lookup is keyed on A's lookupHash but resolves to B's doc/hash.
    mockFindInviteByLookupHash.mockResolvedValue(docForB);

    const result = await verifyInvite(issuedA.plaintext);

    expect(result).toBeNull();
  });
});

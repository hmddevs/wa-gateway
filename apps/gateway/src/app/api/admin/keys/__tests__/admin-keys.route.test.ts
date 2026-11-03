/**
 * Admin API key management route tests.
 *
 * POST /api/admin/keys, create an API key.
 *
 * Covers the project-purpose gate requirement that `projectId` is required
 * on key creation, and that it must satisfy the `ProjectIdSchema` regex
 * (lowercase kebab slug, 1–64 chars). Also covers that the persisted
 * `ApiKeyDoc` carries the supplied `projectId`.
 *
 * Mocked boundaries:
 *   - @/lib/require-admin
 *   - @/lib/api-key, issueApiKey
 *   - @/lib/repositories/api-keys, insertKey, listKeys
 *   - @/lib/repositories/audit, appendAudit
 *   - @/lib/request-id, mintRequestId
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- module mocks -----------------------------------------------------------

vi.mock('@/lib/require-admin', () => ({
  requireAdmin: vi.fn(),
}));

vi.mock('@/lib/api-key', () => ({
  issueApiKey: vi.fn(async ({ division, env }: { division: string; env: string }) => ({
    keyId: `key_${division}_${env}`,
    keyLookupHash: 'a'.repeat(64),
    keyHash: '$argon2id$v=19$m=65536,t=3,p=4$fake',
    plaintext: 'hmd_live_plaintext',
  })),
}));

vi.mock('@/lib/repositories/api-keys', () => ({
  insertKey: vi.fn().mockResolvedValue(undefined),
  listKeys: vi.fn().mockResolvedValue([]),
}));

vi.mock('@/lib/repositories/audit', () => ({
  appendAudit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/request-id', () => ({
  mintRequestId: vi.fn(() => 'req-test'),
}));

// ---- imports after mocks ----------------------------------------------------

import { POST } from '@/app/api/admin/keys/route';
import { requireAdmin } from '@/lib/require-admin';
import { insertKey } from '@/lib/repositories/api-keys';
import type { ApiKeyDoc } from '@/lib/repositories/api-keys';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockRequireAdmin = requireAdmin as ReturnType<typeof vi.fn>;
const mockInsertKey = insertKey as ReturnType<typeof vi.fn>;

function makeAuthedAdmin() {
  return {
    ok: true as const,
    admin: {
      email: 'admin@hmd.test',
      sessionId: 'admin-sess-1',
      webauthnFreshAt: new Date(),
    },
  };
}

function makeReq(body: unknown): Request {
  return new Request('http://localhost/api/admin/keys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Minimal valid key-creation payload that passes all validations. */
const VALID_PAYLOAD = {
  label: 'Test Key',
  division: 'hmd',
  env: 'live',
  scopes: ['send:transactional'],
  sessionId: 'acme',
  projectId: 'acme',
};

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAdmin.mockResolvedValue(makeAuthedAdmin());
  mockInsertKey.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// projectId, validation
// ---------------------------------------------------------------------------

describe('POST /api/admin/keys, projectId validation', () => {
  it('returns 400 INVALID_BODY when projectId is missing', async () => {
    const { projectId: _, ...payload } = VALID_PAYLOAD;
    const res = await POST(makeReq(payload));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { code: string };
    expect(json.code).toBe('INVALID_BODY');
  });

  it("returns 400 INVALID_BODY when projectId starts with a hyphen ('-foo')", async () => {
    const res = await POST(makeReq({ ...VALID_PAYLOAD, projectId: '-foo' }));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { code: string };
    expect(json.code).toBe('INVALID_BODY');
  });

  it("returns 400 INVALID_BODY when projectId has uppercase characters ('Foo')", async () => {
    const res = await POST(makeReq({ ...VALID_PAYLOAD, projectId: 'Foo' }));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { code: string };
    expect(json.code).toBe('INVALID_BODY');
  });

  it('returns 400 INVALID_BODY when projectId ends with a hyphen', async () => {
    const res = await POST(makeReq({ ...VALID_PAYLOAD, projectId: 'foo-' }));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { code: string };
    expect(json.code).toBe('INVALID_BODY');
  });

  it('returns 400 INVALID_BODY when projectId contains underscores', async () => {
    const res = await POST(makeReq({ ...VALID_PAYLOAD, projectId: 'foo_bar' }));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { code: string };
    expect(json.code).toBe('INVALID_BODY');
  });
});

// ---------------------------------------------------------------------------
// Happy path, projectId persisted
// ---------------------------------------------------------------------------

describe('POST /api/admin/keys, happy path', () => {
  it('returns 201 with keyId and projectId for a valid request', async () => {
    const res = await POST(makeReq(VALID_PAYLOAD));
    expect(res.status).toBe(201);
    const json = (await res.json()) as { projectId: string };
    expect(json.projectId).toBe('acme');
  });

  it('persisted ApiKeyDoc carries the supplied projectId', async () => {
    await POST(makeReq({ ...VALID_PAYLOAD, projectId: 'example-service' }));

    expect(mockInsertKey).toHaveBeenCalledOnce();
    const doc = mockInsertKey.mock.calls[0]![0] as ApiKeyDoc;
    expect(doc.projectId).toBe('example-service');
  });

  it("accepts the 'admin-console' sentinel slug (satisfies the regex)", async () => {
    const res = await POST(makeReq({ ...VALID_PAYLOAD, projectId: 'admin-console' }));
    expect(res.status).toBe(201);
    const json = (await res.json()) as { projectId: string };
    expect(json.projectId).toBe('admin-console');
  });
});

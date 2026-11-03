/**
 * GET /v1/groups, route tests.
 *
 * Mocked boundaries:
 *   - @/lib/auth-api
 *   - @/lib/repositories/chat-events, listSessionGroups
 *   - @/lib/repositories/groups, findGroupsByJids
 *   - @/lib/logger
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GroupDoc } from '@hmddevs/protocol';

// ---- module mocks -----------------------------------------------------------

vi.mock('@/lib/auth-api', () => ({
  authenticate: vi.fn(),
  requireScope: vi.fn(),
}));

vi.mock('@/lib/repositories/chat-events', () => ({
  listSessionGroups: vi.fn(),
}));

vi.mock('@/lib/repositories/groups', () => ({
  findGroupsByJids: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ---- imports after mocks ----------------------------------------------------

import { GET } from '@/app/v1/groups/route';
import { authenticate, requireScope } from '@/lib/auth-api';
import { listSessionGroups } from '@/lib/repositories/chat-events';
import { findGroupsByJids } from '@/lib/repositories/groups';
import type { ApiKeyDoc } from '@/lib/repositories/api-keys';

const mockAuthenticate = authenticate as ReturnType<typeof vi.fn>;
const mockRequireScope = requireScope as ReturnType<typeof vi.fn>;
const mockListSessionGroups = listSessionGroups as ReturnType<typeof vi.fn>;
const mockFindGroupsByJids = findGroupsByJids as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SESSION_A = 'session-a';
const SESSION_B = 'session-b';

function makeApiKey(overrides: Partial<ApiKeyDoc> = {}): ApiKeyDoc {
  return {
    keyId: 'key_abc',
    keyLookupHash: 'abc',
    keyHash: 'hash',
    label: 'Test Key',
    division: 'test',
    env: 'test',
    projectId: 'acme',
    scopes: ['read:groups'],
    rateLimitPerMin: 100,
    sessionId: SESSION_A,
    createdBy: 'admin@test.com',
    createdAt: new Date(),
    ...overrides,
  } as ApiKeyDoc;
}

function makeRequest(): Request {
  return new Request('https://wa.test/v1/groups', {
    method: 'GET',
    headers: { authorization: 'Bearer test-api-key' },
  });
}

/**
 * Simulates a two-tenant chat_events store. The route only ever passes
 * `apiKey.sessionId` through to `listSessionGroups`, so a correctly-scoped
 * implementation returns only the matching session's rows. If the route ever
 * regressed to leak session B's data into session A's response, this fixture
 * catches it.
 */
const FAKE_DB: Record<string, Array<{ jid: string; lastActivityAt: Date }>> = {
  [SESSION_A]: [
    { jid: '120363000000000001@g.us', lastActivityAt: new Date('2026-07-10T00:00:00.000Z') },
  ],
  [SESSION_B]: [
    { jid: '120363999999999999@g.us', lastActivityAt: new Date('2026-07-11T00:00:00.000Z') },
  ],
};

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();

  mockAuthenticate.mockResolvedValue({
    ok: true,
    apiKey: makeApiKey(),
    ip: '1.2.3.4',
    requestId: 'req-test',
  });
  mockRequireScope.mockReturnValue(true);
  mockListSessionGroups.mockImplementation(async (sessionId: string) => FAKE_DB[sessionId] ?? []);
  // Default: no stored metadata for any JID, most tests exercise the
  // activity-only path. Metadata-decoration tests override per-case.
  mockFindGroupsByJids.mockResolvedValue(new Map());
});

// ---------------------------------------------------------------------------
// 401, missing/invalid auth
// ---------------------------------------------------------------------------

describe('GET /v1/groups, unauthenticated', () => {
  it('returns the auth failure response as-is when authenticate() fails', async () => {
    const authFailure = new Response(
      JSON.stringify({ error: 'Missing bearer token', code: 'UNAUTHORIZED', requestId: 'req-x' }),
      { status: 401 },
    );
    mockAuthenticate.mockResolvedValue({ ok: false, response: authFailure });

    const res = await GET(makeRequest());

    expect(res.status).toBe(401);
    expect(mockListSessionGroups).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 403, missing scope
// ---------------------------------------------------------------------------

describe('GET /v1/groups, missing scope', () => {
  it('returns 403 SCOPE_DENIED when the key lacks read:groups', async () => {
    mockRequireScope.mockReturnValue(false);

    const res = await GET(makeRequest());

    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('SCOPE_DENIED');
    expect(mockRequireScope).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: SESSION_A }),
      'read:groups',
    );
    expect(mockListSessionGroups).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 200, tenant isolation
// ---------------------------------------------------------------------------

describe('GET /v1/groups, tenant isolation', () => {
  it('returns only the calling session own groups, never another session groups', async () => {
    const res = await GET(makeRequest());

    expect(res.status).toBe(200);
    const body = (await res.json()) as { groups: Array<{ jid: string }> };

    expect(body.groups).toHaveLength(1);
    expect(body.groups[0]!.jid).toBe('120363000000000001@g.us');
    expect(body.groups.some((g) => g.jid === '120363999999999999@g.us')).toBe(false);
  });

  it('queries the repository with the API key own bound sessionId only', async () => {
    await GET(makeRequest());
    expect(mockListSessionGroups).toHaveBeenCalledOnce();
    expect(mockListSessionGroups).toHaveBeenCalledWith(SESSION_A);
  });

  it('a key bound to a different session sees only that session groups', async () => {
    mockAuthenticate.mockResolvedValue({
      ok: true,
      apiKey: makeApiKey({ sessionId: SESSION_B }),
      ip: '1.2.3.4',
      requestId: 'req-test-b',
    });

    const res = await GET(makeRequest());
    const body = (await res.json()) as { groups: Array<{ jid: string }> };

    expect(body.groups).toHaveLength(1);
    expect(body.groups[0]!.jid).toBe('120363999999999999@g.us');
    expect(body.groups.some((g) => g.jid === '120363000000000001@g.us')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 200, empty case
// ---------------------------------------------------------------------------

describe('GET /v1/groups, empty case', () => {
  it('returns 200 with an empty groups array when the session has no group activity', async () => {
    mockListSessionGroups.mockResolvedValue([]);

    const res = await GET(makeRequest());

    expect(res.status).toBe(200);
    const body = (await res.json()) as { groups: unknown[] };
    expect(body.groups).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 200, response shape
// ---------------------------------------------------------------------------

describe('GET /v1/groups, response shape', () => {
  it('returns groups as { jid, lastActivityAt } with lastActivityAt as an ISO string', async () => {
    const res = await GET(makeRequest());

    expect(res.status).toBe(200);
    const body = (await res.json()) as { groups: Array<{ jid: string; lastActivityAt: string }> };
    expect(body.groups[0]).toEqual({
      jid: '120363000000000001@g.us',
      lastActivityAt: '2026-07-10T00:00:00.000Z',
    });
  });

  it('sets the X-Request-Id response header', async () => {
    const res = await GET(makeRequest());
    expect(res.headers.get('X-Request-Id')).toBe('req-test');
  });
});

// ---------------------------------------------------------------------------
// 200, metadata join (group-metadata feature)
// ---------------------------------------------------------------------------

describe('GET /v1/groups, metadata join', () => {
  it('lists a group with chat activity but no stored metadata, with metadata fields absent', async () => {
    // Default beforeEach already returns an empty Map from findGroupsByJids.
    const res = await GET(makeRequest());

    expect(res.status).toBe(200);
    const body = (await res.json()) as { groups: Array<Record<string, unknown>> };
    expect(body.groups).toHaveLength(1);
    const row = body.groups[0]!;
    expect(row.jid).toBe('120363000000000001@g.us');
    expect('subject' in row).toBe(false);
    expect('participants' in row).toBe(false);
    expect('metadataFetchedAt' in row).toBe(false);
  });

  it('decorates a group with stored metadata, including participants and metadataFetchedAt', async () => {
    const storedDoc: GroupDoc = {
      jid: '120363000000000001@g.us',
      sessionId: SESSION_A,
      subject: 'HMD Ops',
      subjectOwner: '447700900001@s.whatsapp.net',
      subjectTime: '2026-07-01T00:00:00.000Z',
      creation: '2026-01-01T00:00:00.000Z',
      owner: '447700900001@s.whatsapp.net',
      desc: 'Ops chatter',
      announce: false,
      restrict: true,
      size: 2,
      participants: [
        { jid: '447700900001@s.whatsapp.net', admin: 'superadmin' },
        { jid: '447700900002@s.whatsapp.net', admin: null },
      ],
      fetchedAt: '2026-07-20T00:00:00.000Z',
    };
    mockFindGroupsByJids.mockResolvedValue(new Map([[storedDoc.jid, storedDoc]]));

    const res = await GET(makeRequest());

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      groups: Array<{
        jid: string;
        lastActivityAt: string;
        subject?: string;
        participants?: Array<{ jid: string; admin: string | null }>;
        metadataFetchedAt?: string;
      }>;
    };
    expect(body.groups).toHaveLength(1);
    const row = body.groups[0]!;
    expect(row.subject).toBe('HMD Ops');
    expect(row.participants).toEqual([
      { jid: '447700900001@s.whatsapp.net', admin: 'superadmin' },
      { jid: '447700900002@s.whatsapp.net', admin: null },
    ]);
    expect(row.metadataFetchedAt).toBe('2026-07-20T00:00:00.000Z');
  });

  it('keeps jid and lastActivityAt in their existing shape regardless of stored metadata', async () => {
    const storedDoc: GroupDoc = {
      jid: '120363000000000001@g.us',
      sessionId: SESSION_A,
      subject: 'HMD Ops',
      fetchedAt: '2026-07-20T00:00:00.000Z',
    };
    mockFindGroupsByJids.mockResolvedValue(new Map([[storedDoc.jid, storedDoc]]));

    const res = await GET(makeRequest());
    const body = (await res.json()) as { groups: Array<{ jid: string; lastActivityAt: string }> };

    expect(body.groups[0]!.jid).toBe('120363000000000001@g.us');
    expect(body.groups[0]!.lastActivityAt).toBe('2026-07-10T00:00:00.000Z');
  });

  it('still enforces read:groups scope on the metadata-joined endpoint', async () => {
    mockRequireScope.mockReturnValue(false);

    const res = await GET(makeRequest());

    expect(res.status).toBe(403);
    expect(mockFindGroupsByJids).not.toHaveBeenCalled();
  });

  it('queries findGroupsByJids with the caller own sessionId and the activity JIDs', async () => {
    await GET(makeRequest());
    expect(mockFindGroupsByJids).toHaveBeenCalledWith(SESSION_A, ['120363000000000001@g.us']);
  });
});

// ---------------------------------------------------------------------------
// 500, repository failure
// ---------------------------------------------------------------------------

describe('GET /v1/groups, repository failure', () => {
  it('returns 500 INTERNAL when listSessionGroups throws', async () => {
    mockListSessionGroups.mockRejectedValue(new Error('mongo down'));

    const res = await GET(makeRequest());

    expect(res.status).toBe(500);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('INTERNAL');
  });
});

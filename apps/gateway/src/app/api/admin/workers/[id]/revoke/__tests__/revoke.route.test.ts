/**
 * POST /api/admin/workers/:id/revoke, operator revocation lever.
 *
 * Bumps the worker's `tokenGen` high-water so its live refresh token (gen ===
 * old tokenGen) becomes strictly stale and is rejected on the wire. WebAuthn
 * step-up gated. 404 for an unknown worker. Always audited.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/require-admin', () => ({ requireAdmin: vi.fn() }));
vi.mock('@/lib/repositories/worker-state', () => ({
  getWorker: vi.fn(),
  upsertWorker: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/repositories/audit', () => ({ appendAudit: vi.fn().mockResolvedValue(undefined) }));

import { POST } from '@/app/api/admin/workers/[id]/revoke/route';
import { requireAdmin } from '@/lib/require-admin';
import { getWorker, upsertWorker } from '@/lib/repositories/worker-state';
import { appendAudit } from '@/lib/repositories/audit';

const mockRequireAdmin = requireAdmin as ReturnType<typeof vi.fn>;
const mockGetWorker = getWorker as ReturnType<typeof vi.fn>;
const mockUpsertWorker = upsertWorker as ReturnType<typeof vi.fn>;
const mockAppendAudit = appendAudit as ReturnType<typeof vi.fn>;

function authedAdmin() {
  return {
    ok: true as const,
    admin: { email: 'admin@hmd.test', sessionId: 'admin-sess-1', webauthnFreshAt: new Date() },
  };
}

function req(): Request {
  return new Request('http://localhost/api/admin/workers/m1/revoke', { method: 'POST' });
}

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAdmin.mockResolvedValue(authedAdmin());
  mockGetWorker.mockResolvedValue({ workerId: 'm1', tokenGen: 4 });
});

describe('POST /api/admin/workers/:id/revoke', () => {
  it('bumps tokenGen by one and returns the new generation', async () => {
    const res = await POST(req(), ctx('m1'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; workerId: string; tokenGen: number };
    expect(body).toMatchObject({ ok: true, workerId: 'm1', tokenGen: 5 });
    expect(mockUpsertWorker).toHaveBeenCalledWith('m1', { tokenGen: 5 });
  });

  it('treats a worker with no prior tokenGen as gen 0 → bumps to 1', async () => {
    mockGetWorker.mockResolvedValue({ workerId: 'm1' });
    const res = await POST(req(), ctx('m1'));
    expect(res.status).toBe(200);
    expect(mockUpsertWorker).toHaveBeenCalledWith('m1', { tokenGen: 1 });
  });

  it('writes an audit entry naming the admin actor', async () => {
    await POST(req(), ctx('m1'));
    expect(mockAppendAudit).toHaveBeenCalledOnce();
    const entry = mockAppendAudit.mock.calls[0]![0] as {
      action: string;
      target: { kind: string; id: string };
      actor: { email: string };
    };
    expect(entry.action).toBe('worker.token.revoke');
    expect(entry.target).toMatchObject({ kind: 'worker', id: 'm1' });
    expect(entry.actor.email).toBe('admin@hmd.test');
  });

  it('404s an unknown worker without bumping anything', async () => {
    mockGetWorker.mockResolvedValue(null);
    const res = await POST(req(), ctx('ghost'));
    expect(res.status).toBe(404);
    expect(mockUpsertWorker).not.toHaveBeenCalled();
  });

  it('rejects without WebAuthn step-up', async () => {
    mockRequireAdmin.mockResolvedValue({
      ok: false as const,
      status: 401,
      message: 'Step-up required',
    });
    const res = await POST(req(), ctx('m1'));
    expect(res.status).toBe(401);
    expect(mockGetWorker).not.toHaveBeenCalled();
    expect(mockUpsertWorker).not.toHaveBeenCalled();
  });
});

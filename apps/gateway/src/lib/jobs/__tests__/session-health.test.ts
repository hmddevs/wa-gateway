/**
 * session-health.ts, session-disconnect alarm unit tests.
 *
 * Mocks the sessions repo, the Redis client, and `sendAlertEmail`. Covers the
 * detection rule (status + heartbeat staleness), the in-scope filter (skip
 * stopped and never-connected sessions), and the marker-based suppression /
 * recovery lifecycle.
 *
 * The `server-only` guard is neutralised by the vitest.config.ts alias.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionDoc } from '@/lib/repositories/sessions';

const { listSessions, redisSet, redisDel, sendAlertEmail } = vi.hoisted(() => ({
  listSessions: vi.fn(),
  redisSet: vi.fn(),
  redisDel: vi.fn(),
  sendAlertEmail: vi.fn(),
}));

vi.mock('@/lib/repositories/sessions', () => ({ listSessions }));
vi.mock('@/lib/redis', () => ({ getRedis: () => ({ set: redisSet, del: redisDel }) }));
vi.mock('@/lib/email', () => ({ sendAlertEmail }));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { checkSessionHealth } from '@/lib/jobs/session-health';

/** Build a session doc, healthy-by-default, overriding only what the test needs. */
function session(over: Partial<SessionDoc>): SessionDoc {
  return {
    sessionId: 'session-a',
    workerId: 'w1',
    label: 'Notify',
    status: 'connected',
    phoneE164: '+447700900123',
    pairing: null,
    version: null,
    lastHeartbeatAt: new Date(), // fresh
    connectedAt: new Date(Date.now() - 3_600_000),
    createdBy: 'admin',
    createdAt: new Date(Date.now() - 86_400_000),
    stoppedAt: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default Redis behaviour: marker creation succeeds, no marker to delete.
  redisSet.mockResolvedValue('OK');
  redisDel.mockResolvedValue(0);
  sendAlertEmail.mockResolvedValue(undefined);
});

describe('checkSessionHealth, detection and alerting', () => {
  it('alerts on a previously-connected session now pairing (no marker held)', async () => {
    listSessions.mockResolvedValue([session({ status: 'pairing' })]);

    const res = await checkSessionHealth();

    expect(res).toMatchObject({ ok: true, checked: 1, alerted: 1, recovered: 0 });
    expect(redisSet).toHaveBeenCalledWith(
      'wa:alert:session-down:session-a',
      '1',
      'EX',
      expect.any(Number),
      'NX',
    );
    expect(sendAlertEmail).toHaveBeenCalledOnce();
    expect(sendAlertEmail.mock.calls[0]![0].subject).toContain('is DOWN');
  });

  it('suppresses a second alert while the marker is held', async () => {
    // NX returns null when the key already exists.
    redisSet.mockResolvedValue(null);
    listSessions.mockResolvedValue([session({ status: 'pairing' })]);

    const res = await checkSessionHealth();

    expect(res).toMatchObject({ alerted: 0, recovered: 0 });
    expect(sendAlertEmail).not.toHaveBeenCalled();
  });

  it('treats a "connected" session with a stale heartbeat (>5min) as DOWN', async () => {
    listSessions.mockResolvedValue([
      session({ status: 'connected', lastHeartbeatAt: new Date(Date.now() - 6 * 60_000) }),
    ]);

    const res = await checkSessionHealth();

    expect(res.alerted).toBe(1);
    expect(sendAlertEmail).toHaveBeenCalledOnce();
  });

  it('does not alert a healthy session (connected + fresh heartbeat)', async () => {
    listSessions.mockResolvedValue([session({})]);

    const res = await checkSessionHealth();

    expect(res).toMatchObject({ checked: 1, alerted: 0, recovered: 0 });
    expect(redisSet).not.toHaveBeenCalled();
    expect(sendAlertEmail).not.toHaveBeenCalled();
  });
});

describe('checkSessionHealth, recovery', () => {
  it('sends a recovery email and deletes the marker when a down session returns', async () => {
    redisDel.mockResolvedValue(1); // marker existed
    listSessions.mockResolvedValue([session({})]); // now healthy

    const res = await checkSessionHealth();

    expect(res).toMatchObject({ alerted: 0, recovered: 1 });
    expect(redisDel).toHaveBeenCalledWith('wa:alert:session-down:session-a');
    expect(sendAlertEmail).toHaveBeenCalledOnce();
    expect(sendAlertEmail.mock.calls[0]![0].subject).toContain('reconnected');
  });

  it('does not send a recovery email when no marker was held', async () => {
    redisDel.mockResolvedValue(0); // nothing to delete
    listSessions.mockResolvedValue([session({})]);

    const res = await checkSessionHealth();

    expect(res.recovered).toBe(0);
    expect(sendAlertEmail).not.toHaveBeenCalled();
  });
});

describe('checkSessionHealth, scope filter', () => {
  it('ignores a stopped session even when its status is down', async () => {
    listSessions.mockResolvedValue([session({ status: 'pairing', stoppedAt: new Date() })]);

    const res = await checkSessionHealth();

    expect(res.checked).toBe(0);
    expect(redisSet).not.toHaveBeenCalled();
    expect(sendAlertEmail).not.toHaveBeenCalled();
  });

  it('ignores a session not assigned to a worker', async () => {
    listSessions.mockResolvedValue([
      session({ status: 'pairing', workerId: undefined, connectedAt: null, lastHeartbeatAt: null }),
    ]);

    const res = await checkSessionHealth();

    expect(res.checked).toBe(0);
    expect(sendAlertEmail).not.toHaveBeenCalled();
  });

  it('alerts on a worker-assigned session stuck at pairing even if never connected', async () => {
    // The re-pair outage: an invalidated/reset session sits at pairing with
    // connectedAt cleared. It must still alarm.
    listSessions.mockResolvedValue([
      session({ status: 'pairing', connectedAt: null, lastHeartbeatAt: null }),
    ]);
    redisSet.mockResolvedValue('OK');

    const res = await checkSessionHealth();

    expect(res.checked).toBe(1);
    expect(res.alerted).toBe(1);
    expect(sendAlertEmail).toHaveBeenCalledTimes(1);
  });
});

describe('checkSessionHealth, best-effort sends', () => {
  it('does not throw when an email send fails; logs and continues', async () => {
    sendAlertEmail.mockRejectedValue(new Error('resend down'));
    listSessions.mockResolvedValue([session({ status: 'offline' })]);

    await expect(checkSessionHealth()).resolves.toMatchObject({ ok: true });
  });
});

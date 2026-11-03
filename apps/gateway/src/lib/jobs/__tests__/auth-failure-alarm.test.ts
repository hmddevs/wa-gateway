/**
 * auth-failure-alarm.ts: API-key auth-failure alarm unit tests.
 *
 * Mocks the auth-failure window reader, the Redis marker, and sendAlertEmail.
 * Covers the threshold, the SET NX suppression, the systemic (multi-division)
 * vs single-division email copy, and best-effort send behaviour.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { readWindow, redisSet, redisDel, sendAlertEmail } = vi.hoisted(() => ({
  readWindow: vi.fn(),
  redisSet: vi.fn(),
  redisDel: vi.fn(),
  sendAlertEmail: vi.fn(),
}));

vi.mock('@/lib/auth-failure-tracker', () => ({
  readAuthFailureWindow: readWindow,
  AUTH_FAIL_WINDOW_MINUTES: 10,
}));
vi.mock('@/lib/redis', () => ({ getRedis: () => ({ set: redisSet, del: redisDel }) }));
vi.mock('@/lib/email', () => ({ sendAlertEmail }));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { checkAuthFailures } from '@/lib/jobs/auth-failure-alarm';

beforeEach(() => {
  vi.clearAllMocks();
  redisSet.mockResolvedValue('OK'); // marker acquired by default
  redisDel.mockResolvedValue(0);
  sendAlertEmail.mockResolvedValue(undefined);
});

describe('checkAuthFailures', () => {
  it('fires when misses reach the threshold and the marker is free', async () => {
    readWindow.mockResolvedValue({ total: 7, byDivision: { acme: 7 } });

    const res = await checkAuthFailures();

    expect(res).toMatchObject({ ok: true, total: 7, divisions: 1, alerted: 1 });
    expect(redisSet).toHaveBeenCalledWith('wa:alert:authfail', '1', 'EX', expect.any(Number), 'NX');
    expect(sendAlertEmail).toHaveBeenCalledOnce();
    expect(sendAlertEmail.mock.calls[0]![0].subject).toContain('spiking');
  });

  it('suppresses a repeat alert while the marker is held', async () => {
    redisSet.mockResolvedValue(null); // NX miss: marker already set
    readWindow.mockResolvedValue({ total: 20, byDivision: { acme: 20 } });

    const res = await checkAuthFailures();

    expect(res.alerted).toBe(0);
    expect(sendAlertEmail).not.toHaveBeenCalled();
  });

  it('does not fire below the threshold', async () => {
    readWindow.mockResolvedValue({ total: 2, byDivision: { acme: 2 } });

    const res = await checkAuthFailures();

    expect(res).toMatchObject({ total: 2, alerted: 0 });
    expect(redisSet).not.toHaveBeenCalled();
    expect(sendAlertEmail).not.toHaveBeenCalled();
  });

  it('flags SERVER_PEPPER when multiple divisions fail at once', async () => {
    readWindow.mockResolvedValue({
      total: 12,
      byDivision: { acme: 4, core: 3, 'acme-notify': 3, 'session-b': 2 },
    });

    const res = await checkAuthFailures();

    expect(res.divisions).toBe(4);
    expect(sendAlertEmail).toHaveBeenCalledOnce();
    expect(sendAlertEmail.mock.calls[0]![0].text).toContain('SERVER_PEPPER');
  });

  it('attributes a single-division break to a stale consumer key', async () => {
    readWindow.mockResolvedValue({ total: 6, byDivision: { acme: 6 } });

    await checkAuthFailures();

    const body = sendAlertEmail.mock.calls[0]![0].text;
    expect(body).toContain('single division');
    expect(body).not.toContain('MULTIPLE');
  });

  it('does not throw when the email send fails', async () => {
    sendAlertEmail.mockRejectedValue(new Error('resend down'));
    readWindow.mockResolvedValue({ total: 9, byDivision: { acme: 9 } });

    await expect(checkAuthFailures()).resolves.toMatchObject({ ok: true });
  });

  it('ignores zero-miss divisions in the count', async () => {
    readWindow.mockResolvedValue({ total: 5, byDivision: { acme: 5, core: 0 } });

    const res = await checkAuthFailures();

    expect(res.divisions).toBe(1);
  });
});

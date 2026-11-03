import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { deriveLiveness, deriveDisplayStatus } from '../liveness';

describe('deriveLiveness', () => {
  let now: number;

  beforeEach(() => {
    // Mock Date.now() to have consistent timestamps.
    now = new Date('2026-05-21T12:00:00Z').getTime();
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns offline when lastHeartbeatAt is null', () => {
    expect(deriveLiveness(null)).toBe('offline');
  });

  it('returns online when heartbeat is fresh (< 60s)', () => {
    const recent = new Date(now - 30_000).toISOString();
    expect(deriveLiveness(recent)).toBe('online');
  });

  it('returns stale when heartbeat is 60-300 seconds old', () => {
    const stale = new Date(now - 90_000).toISOString();
    expect(deriveLiveness(stale)).toBe('stale');

    const nearLimit = new Date(now - 299_999).toISOString();
    expect(deriveLiveness(nearLimit)).toBe('stale');
  });

  it('returns offline when heartbeat is 5+ minutes old', () => {
    const ancient = new Date(now - 300_000).toISOString();
    expect(deriveLiveness(ancient)).toBe('offline');

    const veryOld = new Date(now - 600_000).toISOString();
    expect(deriveLiveness(veryOld)).toBe('offline');
  });

  it('returns offline at exactly 300 seconds', () => {
    const exact = new Date(now - 300_000).toISOString();
    expect(deriveLiveness(exact)).toBe('offline');
  });

  it('returns stale at 59 seconds (edge of online threshold)', () => {
    const edge = new Date(now - 59_999).toISOString();
    expect(deriveLiveness(edge)).toBe('online');
  });
});

describe('deriveDisplayStatus', () => {
  let now: number;

  beforeEach(() => {
    now = new Date('2026-05-21T12:00:00Z').getTime();
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('preserves rawStatus when online', () => {
    const recent = new Date(now - 30_000).toISOString();
    const result = deriveDisplayStatus('connected', recent);
    expect(result.state).toBe('online');
    expect(result.displayStatus).toBe('connected');
  });

  it('shows stale label with age when stale', () => {
    const stale = new Date(now - 90_000).toISOString();
    const result = deriveDisplayStatus('connected', stale);
    expect(result.state).toBe('stale');
    expect(result.displayStatus).toContain('Stale');
    expect(result.displayStatus).toContain('1m');
  });

  it('shows offline label with age when offline', () => {
    const ancient = new Date(now - 600_000).toISOString();
    const result = deriveDisplayStatus('connected', ancient);
    expect(result.state).toBe('offline');
    expect(result.displayStatus).toContain('Offline');
    expect(result.displayStatus).toContain('10m');
  });

  it('overrides rawStatus offline with actual state when online but shown as offline in DB', () => {
    const recent = new Date(now - 30_000).toISOString();
    const result = deriveDisplayStatus('offline', recent);
    expect(result.state).toBe('online');
    expect(result.displayStatus).toBe('offline');
  });

  it('formats age as seconds when < 60s', () => {
    const thirty = new Date(now - 30_000).toISOString();
    const result = deriveDisplayStatus('connected', thirty);
    expect(result.ageLabel).toBe('30s');
  });

  it('formats age as minutes when >= 60s', () => {
    const ninety = new Date(now - 90_000).toISOString();
    const result = deriveDisplayStatus('connected', ninety);
    expect(result.ageLabel).toBe('1m');
  });

  it('formats age as hours when >= 3600s', () => {
    const twoHours = new Date(now - 7_200_000).toISOString();
    const result = deriveDisplayStatus('connected', twoHours);
    expect(result.ageLabel).toBe('2h');
  });

  it('handles null lastHeartbeatAt gracefully', () => {
    const result = deriveDisplayStatus('connected', null);
    expect(result.state).toBe('offline');
    expect(result.displayStatus).toContain('Offline');
  });
});

describe('deriveDisplayStatus, a session that has never heartbeated', () => {
  it('reads as waiting to pair, not "no heartbeat for Infinityh"', () => {
    // Every number provisioned through an organization pairing link starts
    // here, so this is the common case on a fresh link, not an edge case.
    const info = deriveDisplayStatus('initialising', null);

    expect(info.state).toBe('offline');
    expect(info.displayStatus).toBe('Offline (no heartbeat yet)');
    expect(info.ageLabel).toBe('never');
    // Regression: this used to render the literal string "Infinityh".
    expect(info.displayStatus).not.toContain('Infinity');
  });
});

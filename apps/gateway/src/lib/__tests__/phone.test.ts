/**
 * phone.ts, unit tests for jidToE164.
 *
 * Pure function, no I/O. All tests run without mocks.
 */
import { describe, it, expect } from 'vitest';
import { jidToE164 } from '../phone';

// ---------------------------------------------------------------------------
// Standard individual JID
// ---------------------------------------------------------------------------

describe('jidToE164, individual JID', () => {
  it('converts a standard s.whatsapp.net JID to E.164', () => {
    expect(jidToE164('447700900456@s.whatsapp.net')).toBe('+447700900456');
  });

  it('converts a LID-notation JID (digits:N@s.whatsapp.net) to E.164, stripping the :N device suffix', () => {
    expect(jidToE164('447700900456:5@s.whatsapp.net')).toBe('+447700900456');
  });
});

// ---------------------------------------------------------------------------
// JIDs that must return null
// ---------------------------------------------------------------------------

describe('jidToE164, non-individual JIDs return null', () => {
  it('returns null for a group JID (@g.us)', () => {
    expect(jidToE164('12345-67890@g.us')).toBeNull();
  });

  it('returns null for a broadcast JID (@broadcast)', () => {
    expect(jidToE164('something@broadcast')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Malformed / edge-case strings
// ---------------------------------------------------------------------------

describe('jidToE164, malformed inputs return null', () => {
  it('returns null for a bare string with no @ delimiter', () => {
    expect(jidToE164('not-a-jid')).toBeNull();
  });

  it('returns null when the local part is empty', () => {
    expect(jidToE164('@s.whatsapp.net')).toBeNull();
  });
});

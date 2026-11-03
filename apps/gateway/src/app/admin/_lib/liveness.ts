/**
 * Liveness derivation from heartbeat age.
 * Decouples the last-stored status (which is only updated on Baileys connection
 * events) from the actual daemon health (which we infer from heartbeat freshness).
 */

export type LivenessState = 'online' | 'stale' | 'offline';

export interface LivenessInfo {
  state: LivenessState;
  displayStatus: string;
  ageMs: number;
  ageLabel: string;
}

/**
 * Derive liveness state from the last heartbeat timestamp.
 *
 * @param lastHeartbeatAt ISO timestamp of the last heartbeat, or null if never
 * @returns 'online' if heartbeat in the last minute, 'stale' if within 5 minutes, 'offline' otherwise
 */
export function deriveLiveness(lastHeartbeatAt: string | null): LivenessState {
  if (!lastHeartbeatAt) return 'offline';

  const ageMs = Date.now() - new Date(lastHeartbeatAt).getTime();

  if (ageMs < 60_000) return 'online'; // fresh: heartbeat in last 60s
  if (ageMs < 300_000) return 'stale'; // stale: heartbeat in last 5m
  return 'offline'; // dead: no heartbeat for 5+ minutes
}

/**
 * Format age in milliseconds as a human-readable string.
 */
function formatAge(ageMs: number): string {
  // A session that has never heartbeated has an infinite age, which used to
  // render as the literal "Infinityh". Newly paired numbers sit in exactly
  // that state until their worker first reports in.
  if (!Number.isFinite(ageMs)) return 'never';
  const seconds = Math.floor(ageMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (seconds < 60) return `${seconds}s`;
  if (minutes < 60) return `${minutes}m`;
  return `${hours}h`;
}

/**
 * Compute full liveness display info including formatted age and status label.
 * Pass the raw status from the database to preserve state information when
 * liveness is 'online'.
 *
 * @param rawStatus The stored status ('connected', 'pairing', 'degraded', 'offline', etc)
 * @param lastHeartbeatAt ISO timestamp of the last heartbeat, or null
 * @returns Liveness info including display status and age label
 */
export function deriveDisplayStatus(
  rawStatus: string,
  lastHeartbeatAt: string | null,
): LivenessInfo {
  const liveness = deriveLiveness(lastHeartbeatAt);
  const ageMs = lastHeartbeatAt ? Date.now() - new Date(lastHeartbeatAt).getTime() : Infinity;
  const ageLabel = formatAge(ageMs);

  switch (liveness) {
    case 'online':
      // If heartbeat is fresh, trust the raw status, use it verbatim.
      return {
        state: 'online',
        displayStatus: rawStatus,
        ageMs,
        ageLabel,
      };

    case 'stale':
      // Heartbeat is stale; show the stale state with age.
      return {
        state: 'stale',
        displayStatus: `Stale (no heartbeat for ${ageLabel})`,
        ageMs,
        ageLabel,
      };

    case 'offline':
      // No heartbeat for 5+ minutes, daemon is definitely dead. A session
      // that has never reported at all is still offline, but it has no age to
      // quote: every number provisioned through a pairing link sits here until
      // its worker first checks in.
      return {
        state: 'offline',
        displayStatus: Number.isFinite(ageMs)
          ? `Offline (no heartbeat for ${ageLabel})`
          : 'Offline (no heartbeat yet)',
        ageMs,
        ageLabel,
      };
  }
}

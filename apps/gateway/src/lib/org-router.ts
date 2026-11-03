/**
 * Developed by HMD Developments
 * For HMD WA Gateway
 * www.hmddevs.org
 *
 * Send-time number selection for an organization.
 *
 * Replaces the session-pool picker, which failed over only when a session went
 * `offline`. WhatsApp restricts a number long before its socket drops, so the
 * old check kept routing to a number that reported `connected` and heartbeated
 * normally while delivering nothing. This router filters on send *capacity* and
 * observed health as well as liveness, which is the failure that actually
 * happens. See docs/ORGANIZATIONS.md.
 */
import 'server-only';
import type { SessionBudget } from '@hmddevs/protocol';
import { getOrg } from './repositories/organizations';
import { getCachedSession, type SessionDoc } from './repositories/sessions';
import {
  HEALTH_MIN,
  effectiveBudget,
  getAffinity,
  getHealth,
  nextRotation,
  remainingHourly,
  reserveSend,
  setAffinity,
} from './session-state';

/**
 * Send-path heartbeat freshness. A worker beats every 15s, so this is ~2.3
 * missed beats. Deliberately tighter than the 60s threshold the admin UI uses:
 * on the hot path a hard-crashed worker must shed traffic in ~35s, and a
 * wrongly-skipped jittery number is harmless because the next candidate is
 * also live.
 */
const SEND_FRESH_MAX_AGE_MS = 35_000;

export type RouteFailure =
  /** No such organization, or it has no member sessions. */
  | 'no_sessions'
  /** Members exist but none is live and healthy, an outage. Maps to 503. */
  | 'no_healthy'
  /** Live members exist but every one is out of budget. Maps to 429. */
  | 'all_exhausted';

export type RouteResult = { ok: true; session: SessionDoc } | { ok: false; reason: RouteFailure };

/** A member that passed liveness and health, with the weight used to pick it. */
interface Candidate {
  session: SessionDoc;
  budget: SessionBudget;
  /** Remaining hourly headroom, the weight under `weighted`. */
  headroom: number;
}

/** Live, unpaused, and heartbeating recently enough to be trusted. */
function isLive(s: SessionDoc | null): s is SessionDoc {
  if (!s || s.paused || s.status !== 'connected' || !s.lastHeartbeatAt) return false;
  return Date.now() - s.lastHeartbeatAt.getTime() < SEND_FRESH_MAX_AGE_MS;
}

/**
 * Order candidates by remaining headroom, sampled without replacement so the
 * whole list stays usable as a fallback chain rather than just its head.
 *
 * Proportional rather than "emptiest first" on purpose: always picking the
 * emptiest number makes every sender converge on the same one between
 * reservations, which is the herd behaviour this is meant to avoid.
 */
function weightedOrder(candidates: Candidate[]): Candidate[] {
  const pool = [...candidates];
  const ordered: Candidate[] = [];

  while (pool.length > 0) {
    // +1 keeps a fully-exhausted member reachable as a last resort; its
    // reservation will simply fail and the walk moves on.
    const total = pool.reduce((sum, c) => sum + c.headroom + 1, 0);
    let roll = Math.random() * total;
    let picked = pool.length - 1;
    for (let i = 0; i < pool.length; i += 1) {
      roll -= pool[i]!.headroom + 1;
      if (roll <= 0) {
        picked = i;
        break;
      }
    }
    ordered.push(pool.splice(picked, 1)[0]!);
  }
  return ordered;
}

/**
 * Resolve the number an organization should send this message from.
 *
 * Eligibility → affinity → strategy → reservation. The reservation is what
 * makes the cap hold under concurrency: budget is charged before the message
 * is published, and a candidate that loses the race is refunded so the walk
 * can continue to the next one.
 *
 * `recipient` is the destination E.164 or group JID; pass null to skip
 * affinity (nothing to pin).
 */
export async function routeSend(orgId: string, recipient: string | null): Promise<RouteResult> {
  const org = await getOrg(orgId);
  if (!org || org.sessions.length === 0) return { ok: false, reason: 'no_sessions' };

  const members = await Promise.all(org.sessions.map((sid) => getCachedSession(sid)));
  const live = members.filter(isLive);
  if (live.length === 0) return { ok: false, reason: 'no_healthy' };

  // Health and headroom are independent per session, so one round-trip each.
  const candidates: Candidate[] = (
    await Promise.all(
      live.map(async (session) => {
        const budget = effectiveBudget(session);
        const [health, headroom] = await Promise.all([
          getHealth(session.sessionId),
          remainingHourly(session.sessionId, budget),
        ]);
        return health < HEALTH_MIN ? null : { session, budget, headroom };
      }),
    )
  ).filter((c): c is Candidate => c !== null);

  if (candidates.length === 0) return { ok: false, reason: 'no_healthy' };

  let ordered: Candidate[];
  if (org.strategy === 'priority') {
    // Organization list order, which `candidates` does not preserve.
    const rank = new Map(org.sessions.map((sid, i) => [sid, i]));
    ordered = [...candidates].sort(
      (a, b) => (rank.get(a.session.sessionId) ?? 0) - (rank.get(b.session.sessionId) ?? 0),
    );
  } else if (org.strategy === 'round-robin') {
    const offset = (await nextRotation(orgId)) % candidates.length;
    ordered = [...candidates.slice(offset), ...candidates.slice(0, offset)];
  } else {
    ordered = weightedOrder(candidates);
  }

  // Affinity overrides the strategy's first choice, but never the eligibility
  // filter: a pinned number that is down or unhealthy is simply not in
  // `candidates`, and the walk re-pins to whoever takes the send.
  if (recipient) {
    const pinned = await getAffinity(orgId, recipient);
    const idx = pinned ? ordered.findIndex((c) => c.session.sessionId === pinned) : -1;
    if (idx > 0) ordered.unshift(...ordered.splice(idx, 1));
  }

  for (const c of ordered) {
    if (await reserveSend(c.session.sessionId, c.budget)) {
      if (recipient) {
        // Best-effort: losing the pin costs thread coherence on the next
        // message, not this send.
        await setAffinity(orgId, recipient, c.session.sessionId).catch(() => {});
      }
      return { ok: true, session: c.session };
    }
  }

  return { ok: false, reason: 'all_exhausted' };
}

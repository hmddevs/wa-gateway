/**
 * Shared session-creation + pairing-kickoff logic. Extracted from
 * `api/admin/sessions/route.ts`'s POST handler so the pairing-invite flow
 * (`api/admin/pairing-invites/route.ts`) can create a session and fire the
 * same `start_session` control envelope without duplicating the logic.
 *
 * Behaviour is unchanged for the existing route: it now just calls this
 * helper with the values it always used.
 */
import 'server-only';
import {
  upsertSession,
  getSession,
  invalidateSessionCache,
  type SessionDoc,
} from './repositories/sessions';
import { addSession as addSessionToOrg } from './repositories/organizations';
import { appendAudit } from './repositories/audit';
import { getRedis } from './redis';
import { channels, sign, newNonce, nowIso } from './wire';
import { randomBytes } from 'node:crypto';

export interface CreateSessionAndStartPairingInput {
  sessionId: string;
  label: string;
  workerId: string;
  createdBy: string; // admin email
  /** Audit action name, callers on different routes log a different action
   *  (e.g. `session.create` vs `pairing_invite.create`) for the same effect. */
  auditAction: string;
  /** Extra audit metadata merged alongside `{ workerId, label }`. */
  auditMeta?: Record<string, unknown>;
}

/**
 * Upsert the session doc, invalidate its cache, publish a signed
 * `start_session` control envelope to the worker (best-effort, non-fatal on
 * failure, the worker picks it up via the sessions endpoint on next boot),
 * and append an audit entry.
 */
export async function createSessionAndStartPairing(
  input: CreateSessionAndStartPairingInput,
): Promise<SessionDoc> {
  const { sessionId, label, workerId, createdBy } = input;

  const session = await upsertSession(sessionId, {
    workerId,
    label,
    status: 'initialising',
    phoneE164: null,
    pairing: null,
    version: null,
    lastHeartbeatAt: null,
    connectedAt: null,
    createdBy,
    createdAt: new Date(),
    stoppedAt: null,
  });
  invalidateSessionCache(sessionId).catch(() => {});

  // Signal the worker to start this session.
  try {
    const envelope = await sign({
      type: 'control' as const,
      action: 'start_session' as const,
      sessionId,
      nonce: newNonce(),
      at: nowIso(),
      sig: '',
    });
    const redis = getRedis();
    await redis.publish(channels.control(workerId), JSON.stringify(envelope));
  } catch (err: unknown) {
    // Non-fatal: the worker will pick it up via the sessions endpoint on next boot.
    void err;
  }

  await appendAudit({
    actor: { kind: 'admin', id: createdBy, email: createdBy },
    action: input.auditAction,
    target: { kind: 'session', id: sessionId },
    meta: { workerId, label, ...input.auditMeta },
  }).catch(() => {});

  return session;
}

/** How many `<orgId>-NN` slots to try before falling back to a random suffix. */
const MAX_NUMBERED_SLOTS = 40;

/**
 * Provision the next number for an organization and attach it, ready to pair.
 *
 * Ids read as `org-a-01`, `org-a-02`, … rather than an opaque slug, because
 * these show up in the admin list, in audit entries and in support
 * conversations. The scan for a free slot is a plain read-then-write, so a
 * genuinely simultaneous pair could collide; that case falls through to a
 * random suffix rather than overwriting a live session's document.
 */
export async function provisionOrgNumber(input: {
  orgId: string;
  workerId: string;
  createdBy: string;
  auditAction: string;
  auditMeta?: Record<string, unknown>;
}): Promise<SessionDoc> {
  let sessionId: string | null = null;
  for (let n = 1; n <= MAX_NUMBERED_SLOTS; n += 1) {
    const candidate = `${input.orgId}-${String(n).padStart(2, '0')}`;
    if (!(await getSession(candidate))) {
      sessionId = candidate;
      break;
    }
  }
  sessionId ??= `${input.orgId}-${randomBytes(3).toString('hex')}`;

  const session = await createSessionAndStartPairing({
    sessionId,
    label: sessionId,
    workerId: input.workerId,
    createdBy: input.createdBy,
    auditAction: input.auditAction,
    auditMeta: { orgId: input.orgId, ...input.auditMeta },
  });

  // Attach immediately rather than on connect: the router only ever offers
  // work to a connected number, so an unpaired member is inert, and an
  // attach-on-connect hook would be one more thing to miss. This also stamps
  // the session's own `orgId`, so it is not set twice above.
  await addSessionToOrg(input.orgId, sessionId);

  return session;
}

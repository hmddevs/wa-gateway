/**
 * Worker token generation enforcement for wire routes.
 *
 * `verifyWorkerJwt` proves a token's signature and type, not that it is the
 * worker's CURRENT credential. This module closes that gap: a refresh token
 * whose generation is older than the worker's stored `tokenGen` has been
 * superseded (rotated away by `/refresh`, or deliberately revoked by an admin),
 * and must be rejected on the wire so revocation actually takes effect rather
 * than leaving a 30-day window open on a leaked token.
 *
 * SAFETY INVARIANT: an ACTIVE worker token always has `gen === stored tokenGen`,
 * because `/v1/worker/refresh` mints the new token's gen and writes
 * `tokenGen = newGen` together. So the STRICT `claims.gen < tokenGen` check
 * below NEVER rejects a healthy live worker, it only rejects a token that was
 * deliberately superseded (revoked) or is an old leaked one. The comparison is
 * strict `<`, never `<=`.
 */
import 'server-only';
import { getCachedWorker } from './repositories/worker-state';

/** Thrown when a refresh token's generation is older than the worker's current
 *  `tokenGen`, i.e. the token has been revoked or rotated away. */
export class RevokedTokenError extends Error {
  constructor(message = 'Worker token revoked') {
    super(message);
    this.name = 'RevokedTokenError';
  }
}

type WorkerJwtClaims = {
  workerId: string;
  typ: 'bootstrap' | 'refresh';
  gen?: number;
  jti: string;
};

/**
 * Throw `RevokedTokenError` when `claims` is a refresh token whose generation
 * is strictly older than the worker's stored `tokenGen`. Bootstrap tokens and
 * refresh tokens without a numeric `gen` pass through untouched.
 *
 * Any underlying DB/Redis error propagates to the caller, wire routes catch it
 * and FAIL OPEN so an infra blip never 401s the live workers.
 */
export async function assertWorkerGenerationFresh(claims: WorkerJwtClaims): Promise<void> {
  if (claims.typ !== 'refresh' || typeof claims.gen !== 'number') return;
  const state = await getCachedWorker(claims.workerId);
  const currentGen = state?.tokenGen ?? 0;
  // STRICT `<`: gen === currentGen is the live worker's freshly-rotated token
  // and is accepted; only a strictly-older generation is a superseded credential.
  if (claims.gen < currentGen) {
    throw new RevokedTokenError();
  }
}

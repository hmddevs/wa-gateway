/**
 * Admin guard for route handlers and server actions.
 * - `requireAdmin()` ensures a valid NextAuth session + email on allowlist.
 * - `requireAdmin({ webauthn: true })` additionally requires a fresh
 *   WebAuthn step-up within the last 5 minutes.
 */
import 'server-only';
import { auth } from './auth';
import { adminEmailAllowlist } from './env';
import { cookies } from 'next/headers';
import { findSession } from './repositories/admin-sessions';

export interface AdminContext {
  email: string;
  sessionId: string | null;
  webauthnFreshAt: Date | null;
}

const STEP_UP_MAX_AGE_MS = 5 * 60 * 1_000;

export async function requireAdmin(
  opts: { webauthn?: boolean } = {},
): Promise<{ ok: true; admin: AdminContext } | { ok: false; status: 401 | 403; message: string }> {
  const session = await auth();
  const email = session?.user?.email?.toLowerCase();
  if (!email) return { ok: false, status: 401, message: 'Not signed in' };
  if (!adminEmailAllowlist().includes(email)) {
    return { ok: false, status: 403, message: 'Not an admin' };
  }

  const cookieStore = await cookies();
  const sessionId = cookieStore.get('__Host-hmd-admin')?.value ?? null;
  let webauthnFreshAt: Date | null = null;
  if (sessionId) {
    const sess = await findSession(sessionId);
    if (sess?.webauthnVerifiedAt) webauthnFreshAt = sess.webauthnVerifiedAt;
  }

  if (opts.webauthn) {
    if (!webauthnFreshAt) {
      return { ok: false, status: 403, message: 'WebAuthn step-up required' };
    }
    if (Date.now() - webauthnFreshAt.getTime() > STEP_UP_MAX_AGE_MS) {
      return { ok: false, status: 403, message: 'WebAuthn step-up expired' };
    }
  }

  return { ok: true, admin: { email, sessionId, webauthnFreshAt } };
}

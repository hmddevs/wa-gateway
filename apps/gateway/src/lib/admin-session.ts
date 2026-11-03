/**
 * Admin session cookie helpers. __Host- cookies are secure, path=/, no domain.
 */
import 'server-only';
import { randomBytes } from 'node:crypto';
import { cookies } from 'next/headers';
import {
  insertSession,
  findSession,
  markWebauthn,
  destroySession,
  type AdminSessionDoc,
} from './repositories/admin-sessions';

const COOKIE_NAME = '__Host-hmd-admin';
const MAX_AGE = 60 * 60 * 8; // 8 hours

function newSessionId(): string {
  return randomBytes(32).toString('base64url');
}

export async function createAdminSession(params: {
  email: string;
  ip: string;
  userAgent: string;
}): Promise<string> {
  const sessionId = newSessionId();
  const now = new Date();
  const doc: AdminSessionDoc = {
    sessionId,
    email: params.email.toLowerCase(),
    ip: params.ip,
    userAgent: params.userAgent,
    createdAt: now,
    expiresAt: new Date(now.getTime() + MAX_AGE * 1_000),
    webauthnVerifiedAt: null,
  };
  await insertSession(doc);
  const store = await cookies();
  store.set(COOKIE_NAME, sessionId, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: MAX_AGE,
  });
  return sessionId;
}

export async function markStepUpComplete(): Promise<boolean> {
  const store = await cookies();
  const id = store.get(COOKIE_NAME)?.value;
  if (!id) return false;
  const sess = await findSession(id);
  if (!sess) return false;
  await markWebauthn(id);
  return true;
}

export async function currentAdminSessionId(): Promise<string | null> {
  const store = await cookies();
  return store.get(COOKIE_NAME)?.value ?? null;
}

export async function clearAdminSession(): Promise<void> {
  const store = await cookies();
  const id = store.get(COOKIE_NAME)?.value;
  if (id) await destroySession(id);
  store.delete(COOKIE_NAME);
}

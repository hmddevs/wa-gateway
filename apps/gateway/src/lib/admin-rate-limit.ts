/** Per-admin sliding-window rate limiter (120 req / minute). */
import 'server-only';
import { Ratelimit } from '@upstash/ratelimit';
import { getRest } from './upstash-rest';

const adminLimiter = new Ratelimit({
  redis: getRest(),
  limiter: Ratelimit.slidingWindow(120, '1 m'),
  analytics: false,
  prefix: 'rl:admin',
});

/**
 * Build a non-empty limiter key from the admin guard. Prefers the admin
 * cookie's session id (rotates across logins); falls back to email when
 * the cookie is absent so authed admins cannot dodge the limiter by
 * shedding the cookie.
 */
export function adminLimiterKey(admin: { sessionId: string | null; email: string }): string {
  if (admin.sessionId && admin.sessionId.length > 0) {
    return `sess:${admin.sessionId}`;
  }
  return `email:${admin.email.toLowerCase()}`;
}

/**
 * Returns true when the caller is within its 120-req/min budget. Throws on
 * an empty key, callers must use `adminLimiterKey` to derive one.
 */
export async function checkAdminLimit(key: string): Promise<boolean> {
  if (key.length === 0) {
    throw new Error('checkAdminLimit: empty key');
  }
  const r = await adminLimiter.limit(key);
  return r.success;
}

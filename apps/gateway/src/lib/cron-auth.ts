/**
 * Cron helper, validates `Authorization: Bearer <CRON_SECRET>` from Vercel's
 * cron runner.
 *
 * If `CRON_SECRET` is unset, cron endpoints are open ONLY when
 * `HMD_CRON_DEV_OPEN=1` is explicitly set. We deliberately do not key the
 * dev-mode bypass off `NODE_ENV !== 'production'`: a self-hoster running
 * `NODE_ENV=staging` without `CRON_SECRET` would otherwise expose
 * cron endpoints publicly.
 */
import 'server-only';
import { timingSafeEqual } from 'node:crypto';

export function isCronAuthorized(req: Request): boolean {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return process.env.HMD_CRON_DEV_OPEN === '1';
  const provided = req.headers.get('authorization');
  if (provided === null) return false;
  const expected = `Bearer ${cronSecret}`;
  // Constant-time comparison to avoid leaking the secret via timing. We must
  // guard the byte length first: timingSafeEqual throws on unequal lengths,
  // and an early length check is not itself a meaningful timing oracle here.
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

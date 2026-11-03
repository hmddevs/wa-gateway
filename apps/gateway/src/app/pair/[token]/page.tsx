/**
 * /pair/:token: public, unauthenticated pairing page for a client.
 *
 * Reusable and organization-scoped: the same link adds up to `maxSessions`
 * numbers, so this shell no longer hardcodes a title or count, the org name,
 * the numbers list, and the "add a number" flow all come from the live
 * `GET /api/pair/:token/status` response inside `PairingStatus`.
 *
 * Server-verifies the invite token so an unknown/malformed token 404s before
 * any markup ships.
 *
 * SECURITY: renders no session metadata itself (label, phone, worker id,
 * etc): only the invite-scoped status is ever fetched, via
 * `GET /api/pair/:token/status`, which itself never returns those fields.
 * noindex is inherited from the middleware's global `X-Robots-Tag` and
 * reinforced here via `metadata`, matching `/status`'s convention. IP
 * rate-limited the same as the status route (same `verifyInvite` Mongo
 * lookup runs on every server-rendered load here too).
 */
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { verifyInvite } from '@/lib/pairing-invite';
import { checkIp } from '@/lib/rate-limit';
import { getClientIp } from '@/lib/auth-api';
import { PairingStatus } from './PairingStatus';

export const metadata: Metadata = {
  title: 'Connect WhatsApp: HMD WA Gateway',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default async function PairPage({ params }: { params: Promise<{ token: string }> }) {
  // Same IP rate limit as the status API route: this page hits the identical
  // `verifyInvite` Mongo lookup on every server-rendered load.
  const ip = getClientIp(await headers());
  if (!(await checkIp(ip))) notFound();

  const { token } = await params;
  const invite = await verifyInvite(token);
  if (!invite) notFound();

  return (
    <main className="flex min-h-screen flex-col items-center justify-start px-4 py-12 sm:px-6 sm:py-20">
      <div className="w-full max-w-lg">
        <PairingStatus token={token} />
      </div>
    </main>
  );
}

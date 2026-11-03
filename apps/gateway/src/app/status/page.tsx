/**
 * /status: public, unauthenticated service-status page.
 *
 * Renders a human-readable view of the coarse service state returned by
 * GET /api/status. Server-rendered; re-validates every 15 seconds via
 * Next.js fetch cache. No client-side JS required.
 *
 * SECURITY:
 *   - Fetches only from /api/status, which itself exposes no sensitive data.
 *   - noindex meta is inherited from the root layout (robots: false) and
 *     reinforced here via the exported `metadata` object.
 *   - No session IDs, phone numbers, worker details, or internal errors
 *     are ever rendered.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import {
  overallState,
  STATE_LABEL,
  STATE_MESSAGE,
  STATE_DOT,
  STATE_TEXT,
  STATE_BADGE,
  type WhatsAppState,
} from '@/lib/status-display';
import { readPublicStatus } from '@/lib/status-service';

export const metadata: Metadata = {
  title: 'Service Status: HMD WA Gateway',
  robots: { index: false, follow: false },
};

// Re-validate at most every 15 s (matches the /api/status in-process cache).
// Always render fresh on load; readPublicStatus has its own 15 s cache that
// bounds Mongo load, so this stays cheap.
export const dynamic = 'force-dynamic';

// ── Page ─────────────────────────────────────────────────────────────────────

export default async function StatusPage() {
  const data = await readPublicStatus();

  const whatsapp: WhatsAppState = data?.whatsapp ?? 'down';
  const checkedAt = data?.checkedAt ? new Date(data.checkedAt) : null;
  const gatewayUp = data?.ok === true;
  const overall = overallState(data);

  return (
    <main className="flex min-h-screen flex-col items-center justify-start px-6 py-20">
      <div className="w-full max-w-lg space-y-8">
        {/* Wordmark */}
        <div className="space-y-1">
          <p className="text-xs font-semibold uppercase tracking-[0.25em] text-muted-foreground">
            HMD Developments
          </p>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Service Status</h1>
          <p className="text-sm text-muted-foreground">Live indicator for the WA Gateway.</p>
        </div>

        {/* Overall banner */}
        <div
          className={`flex items-center gap-3 rounded-lg border px-4 py-3 ${STATE_BADGE[overall]}`}
        >
          <span
            className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${STATE_DOT[overall]}`}
            aria-hidden="true"
          />
          <span className="text-sm font-medium">{STATE_MESSAGE[overall]}</span>
        </div>

        {/* Component table */}
        <div className="divide-y divide-border rounded-lg border">
          <div className="flex items-center justify-between px-4 py-3">
            <span className="text-sm font-medium text-foreground">Gateway</span>
            <span
              className={`text-sm font-semibold ${gatewayUp ? STATE_TEXT.operational : STATE_TEXT.down}`}
            >
              {gatewayUp ? 'Operational' : 'Down'}
            </span>
          </div>
          <div className="flex items-center justify-between px-4 py-3">
            <span className="text-sm font-medium text-foreground">WhatsApp session</span>
            <span className={`text-sm font-semibold ${STATE_TEXT[whatsapp]}`}>
              {STATE_LABEL[whatsapp]}
            </span>
          </div>
        </div>

        {/* Last updated */}
        {checkedAt && (
          <p className="text-xs text-muted-foreground">
            Last checked: <time dateTime={checkedAt.toISOString()}>{checkedAt.toUTCString()}</time>
          </p>
        )}

        {/* Back link */}
        <p className="text-xs">
          <Link href="/" className="text-muted-foreground underline-offset-4 hover:underline">
            ← Back
          </Link>
        </p>
      </div>
    </main>
  );
}

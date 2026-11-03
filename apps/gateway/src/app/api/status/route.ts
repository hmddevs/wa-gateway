/**
 * GET /api/status
 *
 * Public, UNAUTHENTICATED coarse-health endpoint.
 *
 * Returns ONLY:
 *   - ok:          always true when this responds (the gateway is up)
 *   - whatsapp:    'operational' | 'degraded' | 'down'
 *   - checkedAt:   ISO timestamp of this response
 *
 * The derivation, the strict worker_state projection, the 15 s in-process
 * cache, and the graceful 'down' fallback all live in `@/lib/status-service`
 * (`readPublicStatus`), shared with the /status page and the homepage card so
 * none of them HTTP-self-fetch.
 *
 * SECURITY: no phone numbers, session/worker ids, counts, or error strings are
 * ever included. X-Robots-Tag noindex + a 15 s public cache are set below.
 */
import { NextResponse } from 'next/server';
import { readPublicStatus } from '@/lib/status-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  const { ok, whatsapp, checkedAt } = await readPublicStatus();

  return NextResponse.json(
    { ok, whatsapp, checkedAt },
    {
      status: 200,
      headers: {
        // 15-second public CDN cache, matches the in-process TTL.
        'Cache-Control': 'public, max-age=15, s-maxage=15',
        // Prevent search engine indexing.
        'X-Robots-Tag': 'noindex, nofollow',
      },
    },
  );
}

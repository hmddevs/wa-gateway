/**
 * GET /api/docs-md/<slug...>
 *
 * Backs the public `/docs/<slug>.md` Markdown export (rewritten here by
 * `next.config.mjs`; see the `rewrites()` entries there for the URL scheme).
 * Renders the corresponding `/docs/<slug>` page and converts its content
 * region to Markdown, see `lib/docs-markdown.ts` for the render mechanism
 * and the reasoning behind it. The `/docs.md` (root docs index) case is
 * handled by the sibling `app/api/docs-md/route.ts`.
 *
 * `path` is validated against `flatNav` (the exhaustive, hand-maintained
 * list of real docs pages in `app/docs/_nav.ts`) before anything is
 * fetched, so this can only ever render a known docs page, never an
 * arbitrary route.
 */
import 'server-only';
import type { NextRequest } from 'next/server';
import { ErrorCodes } from '@hmddevs/protocol';
import { errorResponse } from '@/lib/http';
import { mintRequestId, REQUEST_ID_HEADER } from '@/lib/request-id';
import { logger } from '@/lib/logger';
import { flatNav } from '@/app/docs/_nav';
import { renderDocPageAsMarkdown } from '@/lib/docs-markdown';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const requestId = mintRequestId(req.headers.get(REQUEST_ID_HEADER));
  const { path } = await params;
  const href = `/docs/${path.join('/')}`;

  const navItem = flatNav.find((item) => item.href === href);
  if (!navItem) {
    return errorResponse(404, ErrorCodes.NOT_FOUND, 'Unknown docs page.', requestId);
  }

  try {
    const markdown = await renderDocPageAsMarkdown(href, navItem.title);
    return new Response(markdown, {
      status: 200,
      headers: {
        'Content-Type': 'text/markdown; charset=utf-8',
        // Matches the site-wide `private, no-store, max-age=0` invariant
        // (see lib/security-headers.ts), the gateway is invite-only and
        // must never be cached or indexed. Middleware sets this
        // authoritatively on every response regardless; set explicitly here
        // too so the header is correct even if middleware is bypassed in a
        // future refactor.
        'Cache-Control': 'private, no-store, max-age=0',
        'X-Request-Id': requestId,
      },
    });
  } catch (err) {
    logger.error({ requestId, href, err }, 'docs-md render failed');
    return errorResponse(
      500,
      ErrorCodes.INTERNAL,
      'Failed to render docs page as Markdown.',
      requestId,
    );
  }
}

/**
 * GET /api/docs-md
 *
 * Backs the public `/docs.md` Markdown export of the docs index page
 * (`/docs`). Nested pages (`/docs/<slug>.md`) are handled by the sibling
 * catch-all at `app/api/docs-md/[...path]/route.ts`, see there for the
 * full explanation of the render mechanism and slug validation.
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

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = mintRequestId(req.headers.get(REQUEST_ID_HEADER));

  const navItem = flatNav.find((item) => item.href === '/docs');
  if (!navItem) {
    return errorResponse(404, ErrorCodes.NOT_FOUND, 'Unknown docs page.', requestId);
  }

  try {
    const markdown = await renderDocPageAsMarkdown('/docs', navItem.title);
    return new Response(markdown, {
      status: 200,
      headers: {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Cache-Control': 'private, no-store, max-age=0',
        'X-Request-Id': requestId,
      },
    });
  } catch (err) {
    logger.error({ requestId, href: '/docs', err }, 'docs-md render failed');
    return errorResponse(
      500,
      ErrorCodes.INTERNAL,
      'Failed to render docs page as Markdown.',
      requestId,
    );
  }
}

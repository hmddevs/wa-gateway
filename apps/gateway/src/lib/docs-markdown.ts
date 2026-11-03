/**
 * Renders a docs page (`/docs/<slug>`) as Markdown, for the `/docs/<slug>.md`
 * export used by the "Copy page as Markdown" feature (routes wired in
 * `app/api/docs-md/route.ts` and `app/api/docs-md/[...path]/route.ts`,
 * reached via the `next.config.mjs` rewrite).
 *
 * Approach: self-origin fetch. Docs pages mix sync page components with
 * async server components (`CodeBlock`, `CodeSample` highlight with shiki),
 * so importing and rendering the page component tree directly would mean
 * reimplementing React's async server-render pipeline. Fetching the page's
 * own rendered HTML and converting it is simpler and can never drift from
 * what a reader actually sees.
 *
 * The fetch target is `env.GATEWAY_PUBLIC_URL` (the same trusted, validated
 * origin used elsewhere for building absolute links, e.g. pairing invites),
 * NOT the inbound request's `Host` header. `Host` is attacker-influenceable
 * (Cloudflare forwards it largely as received); building a fetch target from
 * it would be a Host-header-injection / SSRF vector. Routing the self-fetch
 * through the public origin also means it arrives back at this same app via
 * Cloudflare with a legitimate trusted-header peer IP, so it clears the
 * `enforceCloudflareOrigin` middleware lock the same as any real visitor
 * request, a direct loopback fetch would not (loopback traffic never
 * carries that header and the origin lock fails closed on that).
 */
import 'server-only';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { env } from '@/lib/env';

const FETCH_TIMEOUT_MS = 8_000;

let turndownService: TurndownService | null = null;

function getTurndownService(): TurndownService {
  if (turndownService) return turndownService;

  const service = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '_',
  });
  service.use(gfm);

  // UI chrome that has no place in a Markdown export: copy buttons and the
  // duplicate dark-theme code-block render (see code-block.tsx / code-sample.tsx).
  service.remove((node) => {
    const el = node as unknown as { getAttribute?: (name: string) => string | null };
    return el.getAttribute?.('data-md-skip') === 'true';
  });

  turndownService = service;
  return service;
}

// Matches the single top-level `<article class="doc-prose">…</article>` every
// docs page renders (see app/docs/layout.tsx and any app/docs/.../page.tsx).
const ARTICLE_RE = /<article[^>]*\bclass="[^"]*\bdoc-prose\b[^"]*"[^>]*>([\s\S]*?)<\/article>/;

const HEADING_RE = /<h1[\s>]/i;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Rewrite root-relative `href="/…"` attributes to absolute canonical URLs. */
function absolutiseLinks(html: string): string {
  return html.replace(/href="\/(?!\/)([^"]*)"/g, (_match, rest: string) => {
    return `href="${env.GATEWAY_PUBLIC_URL}/${rest}"`;
  });
}

class DocsMarkdownError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DocsMarkdownError';
  }
}

/**
 * Fetch `href` (a validated docs route, e.g. `/docs/messages`) from this
 * app's own public origin, extract the `<article class="doc-prose">` content
 * region (excludes sidebar nav, mobile nav, header, TOC, and the prev/next
 * pager, none of which live inside the article), and convert it to Markdown.
 */
export async function renderDocPageAsMarkdown(href: string, title: string): Promise<string> {
  const target = new URL(href, env.GATEWAY_PUBLIC_URL).toString();

  let res: Response;
  try {
    res = await fetch(target, {
      // The self-fetch is same-app, but still traverses Cloudflare + the
      // deployment's own edge; give it a hard ceiling so a slow upstream
      // never hangs this route.
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: 'text/html' },
      cache: 'no-store',
    });
  } catch (err) {
    throw new DocsMarkdownError(`docs-md self-fetch failed for ${href}`, { cause: err });
  }

  if (!res.ok) {
    throw new DocsMarkdownError(`docs-md self-fetch returned ${res.status} for ${href}`);
  }

  const html = await res.text();
  const match = ARTICLE_RE.exec(html);
  if (!match || !match[1]) {
    throw new DocsMarkdownError(`docs-md could not locate doc-prose content for ${href}`);
  }

  let fragment = absolutiseLinks(match[1]);
  if (!HEADING_RE.test(fragment)) {
    fragment = `<h1>${escapeHtml(title)}</h1>\n${fragment}`;
  }

  const markdown = getTurndownService().turndown(fragment);

  // Turndown can leave 3+ consecutive blank lines around removed nodes
  // (e.g. where the skipped copy-button/dark-theme siblings used to sit);
  // tidy them to a single blank line.
  return markdown.replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

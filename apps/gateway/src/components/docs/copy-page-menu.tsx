'use client';

import * as React from 'react';
import { usePathname } from 'next/navigation';
import { Check, ChevronDown, Copy, FileText, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

type CopyState = 'idle' | 'copied' | 'error';

/** Maps the current docs pathname to its `.md` export path (see next.config.mjs rewrites). */
function pathToMarkdownPath(pathname: string): string {
  if (pathname === '/docs' || pathname === '/docs/') {
    return '/docs.md';
  }
  return `${pathname.replace(/\/+$/, '')}.md`;
}

/**
 * "Copy page" control for the docs header: a primary copy-as-Markdown button
 * joined to a chevron dropdown with the copy and view-as-Markdown actions.
 * Excluded from the /docs/*.md Markdown export (see
 * lib/docs-markdown.ts); it is UI chrome, not content, and it also lives
 * outside `.doc-prose`, so it would not leak into exports regardless.
 */
export function CopyPageMenu({ className }: { className?: string }) {
  const pathname = usePathname();
  const [copyState, setCopyState] = React.useState<CopyState>('idle');
  const resetTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const markdownPath = pathToMarkdownPath(pathname);

  React.useEffect(() => {
    return () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    };
  }, []);

  function flashState(state: CopyState) {
    setCopyState(state);
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setCopyState('idle'), 1800);
  }

  async function handleCopy() {
    try {
      const res = await fetch(markdownPath);
      if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
      const markdown = await res.text();
      await navigator.clipboard.writeText(markdown);
      flashState('copied');
    } catch {
      flashState('error');
    }
  }

  function absoluteMarkdownUrl(): string {
    const origin =
      typeof window !== 'undefined' ? window.location.origin : 'https://wa.example.com';
    return `${origin}${markdownPath}`;
  }

  function handleViewAsMarkdown() {
    window.open(absoluteMarkdownUrl(), '_blank', 'noopener,noreferrer');
  }

  const icon =
    copyState === 'copied' ? (
      <Check className="h-3.5 w-3.5" aria-hidden="true" />
    ) : copyState === 'error' ? (
      <X className="h-3.5 w-3.5" aria-hidden="true" />
    ) : (
      <Copy className="h-3.5 w-3.5" aria-hidden="true" />
    );

  const label = copyState === 'copied' ? 'Copied' : copyState === 'error' ? 'Failed' : 'Copy page';

  return (
    <div data-md-skip="true" className={cn('hidden items-center sm:inline-flex', className)}>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={handleCopy}
        className="gap-1.5 rounded-r-none border-r-0"
      >
        {icon}
        {label}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label="More copy page options"
            className="rounded-l-none px-1.5"
          >
            <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          <DropdownMenuItem onSelect={() => handleCopy()} className="items-start gap-2.5 py-2">
            <Copy className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <div className="flex min-w-0 flex-col">
              <span className="text-sm font-medium leading-tight text-foreground">Copy page</span>
              <span className="text-xs leading-snug text-muted-foreground">
                Copy page as Markdown for LLMs
              </span>
            </div>
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => handleViewAsMarkdown()}
            className="items-start gap-2.5 py-2"
          >
            <FileText
              className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            <div className="flex min-w-0 flex-col">
              <span className="text-sm font-medium leading-tight text-foreground">
                View as Markdown
              </span>
              <span className="text-xs leading-snug text-muted-foreground">
                View this page as plain text
              </span>
            </div>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

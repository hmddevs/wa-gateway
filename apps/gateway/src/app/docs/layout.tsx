import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { MessageCircle } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { SidebarNav } from '@/components/docs/sidebar-nav';
import { MobileNav } from '@/components/docs/mobile-nav';
import { ThemeToggle } from '@/components/docs/theme-toggle';
import { SearchTrigger } from '@/components/docs/search-trigger';
import { TableOfContents } from '@/components/docs/table-of-contents';
import { DocPager } from '@/components/docs/doc-pager';
import { SearchProvider, SearchDialog } from '@/components/docs/search-dialog';
import { CopyPageMenu } from '@/components/docs/copy-page-menu';

export const metadata: Metadata = {
  title: {
    default: 'HMD WA Gateway API Documentation',
    template: '%s · HMD WA Gateway',
  },
  description: 'Reference and integration guides for the HMD WA Gateway HTTP API.',
  robots: { index: false, follow: false },
};

export default function DocsLayout({ children }: { children: ReactNode }) {
  return (
    <SearchProvider>
      <div className="min-h-screen bg-background">
        {/* ── Top bar ─────────────────────────────────────────────────────── */}
        <header className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
          <div className="mx-auto flex h-14 max-w-screen-2xl items-center gap-3 px-4 sm:px-6">
            <MobileNav />
            <Link
              href="/"
              className="flex items-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
            >
              <span className="flex h-7 w-7 items-center justify-center rounded-md bg-primary/10 text-primary">
                <MessageCircle className="h-4 w-4" aria-hidden="true" />
              </span>
              <span className="flex flex-col leading-none">
                <span className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                  HMD
                </span>
                <span className="text-sm font-semibold tracking-tight text-foreground">
                  WA Gateway
                </span>
              </span>
            </Link>

            <div className="ml-auto flex items-center gap-2">
              <SearchTrigger />
              <CopyPageMenu />
              <a
                href="mailto:security@hmddevs.org?subject=WA%20Gateway%20API%20key%20request"
                className="hidden rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:inline-flex"
              >
                Get API key
              </a>
              <ThemeToggle />
            </div>
          </div>
        </header>

        {/* ── Body grid ───────────────────────────────────────────────────── */}
        <div className="mx-auto flex max-w-screen-2xl gap-0 px-4 sm:px-6">
          {/* Left rail */}
          <aside className="hidden w-60 shrink-0 lg:block">
            <ScrollArea className="sticky top-14 h-[calc(100vh-3.5rem)] py-8 pr-4">
              <SidebarNav />
            </ScrollArea>
          </aside>

          {/* Content + right TOC */}
          <div className="flex min-w-0 flex-1 justify-center gap-10 lg:pl-8">
            <main className="min-w-0 max-w-3xl flex-1 py-10">
              {children}
              <DocPager />
            </main>
            <aside className="hidden w-56 shrink-0 xl:block">
              <div className="sticky top-14 py-10">
                <TableOfContents />
              </div>
            </aside>
          </div>
        </div>
      </div>
      <SearchDialog />
    </SearchProvider>
  );
}

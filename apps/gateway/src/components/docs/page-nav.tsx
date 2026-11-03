import Link from 'next/link';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

interface NavItem {
  title: string;
  href: string;
}

interface PageNavProps {
  prev?: NavItem;
  next?: NavItem;
}

export function PageNav({ prev, next }: PageNavProps) {
  if (!prev && !next) return null;

  return (
    <nav
      aria-label="Page navigation"
      className="mt-10 flex items-stretch gap-3 border-t border-border pt-8"
    >
      {prev ? (
        <Link
          href={prev.href}
          className={cn(
            'group flex flex-1 flex-col gap-1 rounded-lg border border-border bg-card px-4 py-3 text-sm transition-colors hover:border-primary/50 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          )}
        >
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <ChevronLeft className="h-3 w-3" aria-hidden="true" />
            Previous
          </span>
          <span className="font-medium text-foreground group-hover:text-primary">{prev.title}</span>
        </Link>
      ) : (
        <div className="flex-1" />
      )}

      {next && (
        <Link
          href={next.href}
          className="group flex flex-1 flex-col items-end gap-1 rounded-lg border border-border bg-card px-4 py-3 text-sm transition-colors hover:border-primary/50 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            Next
            <ChevronRight className="h-3 w-3" aria-hidden="true" />
          </span>
          <span className="font-medium text-foreground group-hover:text-primary">{next.title}</span>
        </Link>
      )}
    </nav>
  );
}

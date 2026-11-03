'use client';

import { Search } from 'lucide-react';
import { useSearch } from './search-dialog';
import { cn } from '@/lib/utils';

/** Opens the command-palette search dialog. Mirrors the ⌘K shortcut. */
export function SearchTrigger({ className }: { className?: string }) {
  const { setOpen } = useSearch();

  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      aria-label="Search documentation"
      className={cn(
        'inline-flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        className,
      )}
    >
      <Search className="h-4 w-4" aria-hidden="true" />
      <span className="hidden sm:inline">Search docs</span>
      <kbd className="ml-2 hidden rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[10px] font-medium sm:inline-flex">
        ⌘K
      </kbd>
    </button>
  );
}

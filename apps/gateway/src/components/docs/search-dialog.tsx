'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Search } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { searchIndex, type SearchItem } from '@/app/docs/_nav';
import { cn } from '@/lib/utils';

// ── Shared open-state context ────────────────────────────────────────────────

interface SearchContextValue {
  open: boolean;
  setOpen: (v: boolean) => void;
}

const SearchContext = React.createContext<SearchContextValue>({
  open: false,
  setOpen: () => undefined,
});

export function SearchProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);

  // ⌘K / Ctrl-K global shortcut
  React.useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return <SearchContext.Provider value={{ open, setOpen }}>{children}</SearchContext.Provider>;
}

export function useSearch() {
  return React.useContext(SearchContext);
}

// ── Filtering ────────────────────────────────────────────────────────────────

function filterItems(query: string): SearchItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return searchIndex.slice(0, 8);
  return searchIndex.filter((item) => {
    const haystack = [item.title, item.group, ...(item.keywords ?? [])].join(' ').toLowerCase();
    return haystack.includes(q);
  });
}

// ── Dialog ───────────────────────────────────────────────────────────────────

export function SearchDialog() {
  const { open, setOpen } = useSearch();
  const router = useRouter();
  const [query, setQuery] = React.useState('');
  const [cursor, setCursor] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const listRef = React.useRef<HTMLUListElement>(null);

  const results = filterItems(query);

  // Reset on open
  React.useEffect(() => {
    if (open) {
      setQuery('');
      setCursor(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  // Keep cursor in bounds when results change
  React.useEffect(() => {
    setCursor(0);
  }, [query]);

  function navigate(href: string) {
    setOpen(false);
    router.push(href);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setCursor((c) => Math.min(c + 1, results.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setCursor((c) => Math.max(c - 1, 0));
        break;
      case 'Enter':
        e.preventDefault();
        if (results[cursor]) navigate(results[cursor].href);
        break;
      case 'Escape':
        setOpen(false);
        break;
    }
  }

  // Scroll active item into view
  React.useEffect(() => {
    const el = listRef.current?.children[cursor] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-lg gap-0 overflow-hidden p-0" aria-describedby={undefined}>
        <DialogTitle className="sr-only">Search documentation</DialogTitle>

        {/* Input */}
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <input
            ref={inputRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search docs…"
            className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
            aria-label="Search documentation"
            aria-autocomplete="list"
            aria-controls="search-results"
            aria-activedescendant={results[cursor] ? `search-item-${cursor}` : undefined}
          />
          <kbd className="hidden rounded border border-border px-1.5 py-0.5 font-mono text-xs text-muted-foreground sm:inline-flex">
            Esc
          </kbd>
        </div>

        {/* Results */}
        <ul
          ref={listRef}
          id="search-results"
          role="listbox"
          aria-label="Search results"
          className="max-h-80 overflow-y-auto py-2"
        >
          {results.length === 0 ? (
            <li className="px-4 py-8 text-center text-sm text-muted-foreground">
              No results for &ldquo;{query}&rdquo;
            </li>
          ) : (
            results.map((item, i) => (
              <li
                key={item.href}
                role="option"
                aria-selected={cursor === i}
                id={`search-item-${i}`}
              >
                <button
                  type="button"
                  onMouseEnter={() => setCursor(i)}
                  onClick={() => navigate(item.href)}
                  className={cn(
                    'flex w-full flex-col gap-0.5 px-4 py-2 text-left transition-colors',
                    cursor === i ? 'bg-muted' : 'hover:bg-muted/50',
                  )}
                >
                  <span className="text-sm font-medium text-foreground">{item.title}</span>
                  <span className="text-xs text-muted-foreground">{item.group}</span>
                </button>
              </li>
            ))
          )}
        </ul>
      </DialogContent>
    </Dialog>
  );
}

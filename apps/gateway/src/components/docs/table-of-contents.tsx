'use client';

import * as React from 'react';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

interface Heading {
  id: string;
  text: string;
  level: 2 | 3;
}

function collectHeadings(): Heading[] {
  const nodes = document.querySelectorAll<HTMLHeadingElement>('article h2[id], article h3[id]');
  return Array.from(nodes).map((el) => ({
    id: el.id,
    text: el.textContent ?? '',
    level: Number(el.tagName[1]) as 2 | 3,
  }));
}

export function TableOfContents() {
  const pathname = usePathname();
  const [headings, setHeadings] = React.useState<Heading[]>([]);
  const [activeId, setActiveId] = React.useState<string>('');

  // Re-collect headings on route change
  React.useEffect(() => {
    setHeadings(collectHeadings());
    setActiveId('');
  }, [pathname]);

  // IntersectionObserver to track active section
  React.useEffect(() => {
    if (headings.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        // Pick the first visible heading
        const visible = entries.filter((e) => e.isIntersecting);
        const firstVisible = visible[0];
        if (firstVisible) {
          setActiveId(firstVisible.target.id);
        }
      },
      { rootMargin: '-80px 0px -60% 0px', threshold: 0 },
    );

    headings.forEach(({ id }) => {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    });

    return () => observer.disconnect();
  }, [headings]);

  function handleClick(e: React.MouseEvent<HTMLAnchorElement>, id: string) {
    e.preventDefault();
    const el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setActiveId(id);
      // Update URL hash without navigation
      window.history.replaceState(null, '', `#${id}`);
    }
  }

  if (headings.length === 0) return null;

  return (
    <nav aria-label="On this page" className="hidden xl:block">
      <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
        On this page
      </p>
      <ul className="space-y-1 text-sm">
        {headings.map(({ id, text, level }) => (
          <li key={id}>
            <a
              href={`#${id}`}
              onClick={(e) => handleClick(e, id)}
              className={cn(
                'block truncate py-0.5 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                level === 3 && 'pl-3',
                activeId === id ? 'font-medium text-primary' : 'text-muted-foreground',
              )}
            >
              {text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { navTree } from '@/app/docs/_nav';
import { cn } from '@/lib/utils';

/** The grouped documentation navigation. Shared by the desktop rail and the mobile sheet. */
export function SidebarNav() {
  const pathname = usePathname();

  return (
    <nav aria-label="Documentation" className="space-y-7">
      {navTree.map((group) => (
        <div key={group.group}>
          <p className="mb-2 px-3 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
            {group.group}
          </p>
          <ul className="space-y-0.5">
            {group.items.map((item) => {
              const active = pathname === item.href;
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'block rounded-md px-3 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      active
                        ? 'bg-primary/10 font-medium text-primary'
                        : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                    )}
                  >
                    {item.title}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

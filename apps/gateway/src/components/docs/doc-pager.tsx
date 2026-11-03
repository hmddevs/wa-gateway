'use client';

import { usePathname } from 'next/navigation';
import { getPageNav } from '@/app/docs/_nav';
import { PageNav } from './page-nav';

/**
 * Renders the previous/next links for the current page, resolved from the flat
 * nav order. Lives in the docs layout so content pages never wire paging by hand.
 */
export function DocPager() {
  const pathname = usePathname();
  const { prev, next } = getPageNav(pathname);
  return <PageNav prev={prev} next={next} />;
}

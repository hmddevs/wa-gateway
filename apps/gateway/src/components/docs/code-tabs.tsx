'use client';

import * as React from 'react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';

interface CodeTabItem {
  label: string;
  content: React.ReactNode;
}

interface CodeTabsProps {
  tabs: CodeTabItem[];
}

/**
 * Client tab chrome only. Receives pre-highlighted ReactNode children from a
 * server parent (CodeSample). Do not pass raw code strings here, highlight
 * server-side and hand the rendered nodes in.
 */
export function CodeTabs({ tabs }: CodeTabsProps) {
  const first = tabs[0];
  if (!first) return null;

  return (
    <Tabs defaultValue={first.label} className="w-full">
      <TabsList
        className="h-auto rounded-none rounded-t-lg border border-b-0 border-border bg-muted/60 p-0"
        // Tab labels ("curl", "TypeScript", …) are UI chrome, not content:
        // excluded from the /docs/*.md Markdown export (lib/docs-markdown.ts),
        // which only ever sees the default-selected tab's code anyway (Radix
        // Tabs doesn't mount inactive TabsContent).
        data-md-skip="true"
      >
        {tabs.map((tab) => (
          <TabsTrigger
            key={tab.label}
            value={tab.label}
            className="rounded-none rounded-tl-lg px-4 py-2 text-xs font-medium first:rounded-tl-lg data-[state=active]:bg-card data-[state=active]:shadow-none"
          >
            {tab.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {tabs.map((tab) => (
        <TabsContent key={tab.label} value={tab.label} className="mt-0">
          {tab.content}
        </TabsContent>
      ))}
    </Tabs>
  );
}

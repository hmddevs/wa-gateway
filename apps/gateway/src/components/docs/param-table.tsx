import type { ReactNode } from 'react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

export interface ParamRow {
  name: string;
  type: string;
  required?: boolean;
  default?: string;
  description: ReactNode;
}

interface ParamTableProps {
  rows: ParamRow[];
}

export function ParamTable({ rows }: ParamTableProps) {
  return (
    <div className="my-4 overflow-x-auto rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow className="border-b border-border hover:bg-transparent">
            <TableHead className="w-40 pl-4 font-semibold">Field</TableHead>
            <TableHead className="w-32 font-semibold">Type</TableHead>
            <TableHead className="w-24 font-semibold">Required</TableHead>
            <TableHead className="w-28 font-semibold">Default</TableHead>
            <TableHead className="font-semibold">Description</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.name} className="border-b border-border last:border-0">
              <TableCell className="pl-4 align-top">
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                  {row.name}
                </code>
              </TableCell>
              <TableCell className="align-top">
                <span className="font-mono text-xs text-muted-foreground">{row.type}</span>
              </TableCell>
              <TableCell className="align-top">
                {row.required ? (
                  <span className="inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                    required
                  </span>
                ) : (
                  <span className="text-xs text-muted-foreground">optional</span>
                )}
              </TableCell>
              <TableCell className="align-top">
                {row.default ? (
                  <code className="font-mono text-xs text-muted-foreground">{row.default}</code>
                ) : (
                  <span className="text-xs text-muted-foreground">&mdash;</span>
                )}
              </TableCell>
              <TableCell className="align-top text-sm text-foreground">{row.description}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

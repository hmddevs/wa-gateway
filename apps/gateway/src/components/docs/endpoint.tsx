import { cn } from '@/lib/utils';

type HttpMethod = 'GET' | 'POST' | 'DELETE' | 'PATCH';

interface EndpointProps {
  method: HttpMethod;
  path: string;
}

const methodStyles: Record<HttpMethod, string> = {
  GET: 'bg-primary/10 text-primary border-primary/20',
  POST: 'bg-green-500/10 text-green-600 border-green-500/20 dark:text-green-400',
  DELETE: 'bg-destructive/10 text-destructive border-destructive/20',
  PATCH: 'bg-amber-500/10 text-amber-600 border-amber-500/20 dark:text-amber-400',
};

export function Endpoint({ method, path }: EndpointProps) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/40 px-4 py-3 font-mono text-sm">
      <span
        className={cn(
          'inline-flex items-center rounded border px-2 py-0.5 text-xs font-semibold uppercase tracking-wide',
          methodStyles[method],
        )}
      >
        {method}
      </span>{' '}
      <span className="text-foreground">{path}</span>
    </div>
  );
}

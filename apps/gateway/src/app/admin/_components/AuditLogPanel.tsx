'use client';
import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, AlertTriangle, Loader2, ChevronDown, ChevronUp } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AuditEntry {
  seq: number;
  at: string;
  actor: { kind: 'admin' | 'system' | 'apiKey'; id: string; email?: string };
  action: string;
  target?: { kind: string; id: string };
  meta?: Record<string, unknown>;
}

interface AuditResponse {
  entries: AuditEntry[];
  nextBefore: number | null;
}

type VerifyResult = { ok: true } | { ok: false; brokenAt: number };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function actorBadgeVariant(kind: AuditEntry['actor']['kind']) {
  if (kind === 'admin') return 'default' as const;
  if (kind === 'system') return 'secondary' as const;
  return 'outline' as const;
}

// ---------------------------------------------------------------------------
// useDebounced, returns a debounced value; cleanup prevents stale setState
// calls on unmounted components.
// ---------------------------------------------------------------------------

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AuditLogPanel() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionFilter, setActionFilter] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<VerifyResult | null>(null);
  // Set of entry seq numbers whose meta is currently expanded.
  const [expandedMeta, setExpandedMeta] = useState<Set<number>>(new Set());

  const debouncedFilter = useDebounced(actionFilter, 400);

  const fetchEntries = useCallback(
    async (opts: { before?: number; action?: string; append?: boolean }) => {
      const params = new URLSearchParams({ limit: '50' });
      if (opts.before !== undefined) params.set('before', String(opts.before));
      if (opts.action) params.set('action', opts.action);

      if (opts.append) setLoadingMore(true);
      else setLoading(true);

      try {
        const res = await fetch(`/api/admin/audit?${params.toString()}`, { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as AuditResponse;
        setEntries((prev) => (opts.append ? [...prev, ...data.entries] : data.entries));
        setNextBefore(data.nextBefore);
        setError(null);
      } catch {
        setError('Failed to load audit log.');
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [],
  );

  // Re-fetch whenever the debounced filter changes; cleanup in useDebounced
  // prevents stale setState calls if the component unmounts mid-timeout.
  useEffect(() => {
    void fetchEntries({ action: debouncedFilter || undefined });
  }, [debouncedFilter, fetchEntries]);

  const toggleMeta = (seq: number) => {
    setExpandedMeta((prev) => {
      const next = new Set(prev);
      if (next.has(seq)) next.delete(seq);
      else next.add(seq);
      return next;
    });
  };

  const handleLoadOlder = () => {
    if (nextBefore === null) return;
    void fetchEntries({ before: nextBefore, action: actionFilter || undefined, append: true });
  };

  const handleVerify = async () => {
    setVerifying(true);
    setVerifyResult(null);
    try {
      const res = await fetch('/api/admin/audit/verify', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as VerifyResult;
      setVerifyResult(data);
    } catch {
      setVerifyResult({ ok: false, brokenAt: -1 });
    } finally {
      setVerifying(false);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-4">
          <CardTitle className="text-base">Audit Log</CardTitle>
          <div className="flex items-center gap-2">
            {verifyResult &&
              (verifyResult.ok ? (
                <span className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  Chain intact
                </span>
              ) : (
                <span className="flex items-center gap-1 text-xs text-destructive">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  {verifyResult.brokenAt === -1
                    ? 'Verify failed'
                    : `Chain broken at seq ${verifyResult.brokenAt}`}
                </span>
              ))}
            <Button variant="outline" size="sm" onClick={handleVerify} disabled={verifying}>
              {verifying ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Verify chain'}
            </Button>
          </div>
        </div>
        <Input
          className="mt-3 h-8 text-xs"
          placeholder="Filter by action prefix…"
          value={actionFilter}
          onChange={(e) => setActionFilter(e.target.value)}
        />
      </CardHeader>

      <CardContent className="p-0">
        {loading ? (
          <div className="flex items-center justify-center py-12 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : error ? (
          <p className="px-6 py-4 text-xs text-muted-foreground">{error}</p>
        ) : entries.length === 0 ? (
          <p className="px-6 py-4 text-xs text-muted-foreground">No audit entries found.</p>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-16 font-mono text-xs">#</TableHead>
                  <TableHead className="text-xs">Time</TableHead>
                  <TableHead className="text-xs">Actor</TableHead>
                  <TableHead className="text-xs">Action</TableHead>
                  <TableHead className="text-xs">Target</TableHead>
                  <TableHead className="text-xs">Meta</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.map((entry) => (
                  <TableRow key={entry.seq}>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {entry.seq}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                      {new Date(entry.at).toLocaleString('en-GB')}
                    </TableCell>
                    <TableCell className="text-xs">
                      <div className="flex flex-col gap-0.5">
                        <Badge
                          variant={actorBadgeVariant(entry.actor.kind)}
                          className="w-fit text-[10px] py-0"
                        >
                          {entry.actor.kind}
                        </Badge>
                        <span className="text-muted-foreground font-mono truncate max-w-[140px]">
                          {entry.actor.email ?? entry.actor.id}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="font-mono text-[10px] py-0">
                        {entry.action}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground font-mono">
                      {entry.target ? `${entry.target.kind}:${entry.target.id}` : ', '}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground max-w-[240px]">
                      {entry.meta && Object.keys(entry.meta).length > 0 ? (
                        <div className="flex flex-col gap-1">
                          <button
                            type="button"
                            onClick={() => toggleMeta(entry.seq)}
                            className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                          >
                            {expandedMeta.has(entry.seq) ? (
                              <ChevronUp className="h-3 w-3 shrink-0" />
                            ) : (
                              <ChevronDown className="h-3 w-3 shrink-0" />
                            )}
                            {expandedMeta.has(entry.seq)
                              ? 'Hide details'
                              : `Show details (${Object.keys(entry.meta).length} field${Object.keys(entry.meta).length === 1 ? '' : 's'})`}
                          </button>
                          {expandedMeta.has(entry.seq) && (
                            <pre className="overflow-x-auto rounded bg-muted px-2 py-1.5 text-[10px] leading-relaxed font-mono">
                              {JSON.stringify(entry.meta, null, 2)}
                            </pre>
                          )}
                        </div>
                      ) : (
                        ', '
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            {nextBefore !== null && (
              <div className="flex justify-center py-4">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleLoadOlder}
                  disabled={loadingMore}
                >
                  {loadingMore ? (
                    <>
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                      Loading&hellip;
                    </>
                  ) : (
                    'Load older'
                  )}
                </Button>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

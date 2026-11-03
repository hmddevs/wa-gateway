'use client';
/**
 * SystemHealthPanel, aggregated health view across all workers and sessions.
 *
 * Fetches a single server-side aggregate from GET /api/admin/system/health.
 * Read-only, no step-up required.
 * Auto-refreshes every 30 s, matching MetricsPanel cadence.
 * British English throughout.
 */
import { useCallback, useEffect, useState } from 'react';
import { Activity, AlertTriangle, Inbox, Send, XCircle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { SystemHealthResponse } from '@/app/api/admin/system/health/route';
import { timeAgo } from '../_types';

// ---------------------------------------------------------------------------
// Summary card, matches MetricsPanel SummaryCard exactly.
// ---------------------------------------------------------------------------

interface SummaryCardProps {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
}

function SummaryCard({ icon, label, value }: SummaryCardProps) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-2 px-5 py-5">
        <div className="flex items-center gap-1.5 text-muted-foreground">
          {icon}
          <span className="text-xs">{label}</span>
        </div>
        <div className="text-2xl font-semibold tabular-nums">{value}</div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// SystemHealthPanel
// ---------------------------------------------------------------------------

export function SystemHealthPanel() {
  const [health, setHealth] = useState<SystemHealthResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchHealth = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/system/health', {
        credentials: 'include',
        cache: 'no-store',
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      setHealth((await res.json()) as SystemHealthResponse);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchHealth();
    const id = setInterval(() => void fetchHealth(), 30_000);
    return () => clearInterval(id);
  }, [fetchHealth]);

  const errorRate =
    health && health.send24h.sent + health.send24h.failed > 0
      ? ((health.send24h.failed / (health.send24h.sent + health.send24h.failed)) * 100).toFixed(1)
      : null;

  const Skeleton = () => <div className="animate-pulse rounded bg-muted h-7 w-16" />;

  return (
    <section className="space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold tracking-tight">System health</h2>
          <p className="text-xs text-muted-foreground">
            Aggregated view across all workers. Refreshes every 30 seconds.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void fetchHealth()} disabled={loading}>
          <Activity className="h-3.5 w-3.5" />
          Refresh
        </Button>
      </div>

      {/* Error banner */}
      {error && (
        <div className="flex items-center gap-3 rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-muted-foreground">
          <span className="flex-1">Failed to load health data: {error}</span>
          <Button variant="outline" size="sm" onClick={() => void fetchHealth()}>
            Retry
          </Button>
        </div>
      )}

      {/* Summary cards, 4 across, wrapping */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <SummaryCard
          icon={<Activity className="h-3.5 w-3.5" />}
          label="Workers online"
          value={
            loading && !health ? (
              <Skeleton />
            ) : (
              <span>
                <span
                  className={cn(
                    (health?.workers.online ?? 0) > 0 ? 'text-emerald-500' : 'text-destructive',
                  )}
                >
                  {health?.workers.online ?? 0}
                </span>
                <span className="text-base font-normal text-muted-foreground">
                  {' '}
                  / {health?.workers.total ?? 0}
                </span>
              </span>
            )
          }
        />
        <SummaryCard
          icon={<Inbox className="h-3.5 w-3.5" />}
          label="Total queue depth"
          value={
            loading && !health ? (
              <Skeleton />
            ) : (
              <span
                className={cn((health?.totalQueueDepth ?? 0) > 0 ? 'text-amber-500' : undefined)}
              >
                {health?.totalQueueDepth ?? 0}
              </span>
            )
          }
        />
        <SummaryCard
          icon={<Send className="h-3.5 w-3.5" />}
          label="Sent (24 h)"
          value={loading && !health ? <Skeleton /> : (health?.send24h.sent ?? ', ')}
        />
        <SummaryCard
          icon={<XCircle className="h-3.5 w-3.5" />}
          label="Send error rate (24 h)"
          value={
            loading && !health ? (
              <Skeleton />
            ) : errorRate !== null ? (
              <span className={cn(parseFloat(errorRate) > 0 ? 'text-amber-500' : undefined)}>
                {errorRate}%
              </span>
            ) : (
              <span className="text-muted-foreground">, </span>
            )
          }
        />
      </div>

      {/* Recent worker errors */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <AlertTriangle className="h-4 w-4 text-amber-500" />
            Recent worker errors
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading && !health ? (
            <div className="space-y-2">
              {[1, 2].map((i) => (
                <div key={i} className="animate-pulse rounded bg-muted h-5" />
              ))}
            </div>
          ) : !health || health.recentErrors.length === 0 ? (
            <p className="text-sm text-muted-foreground">No recent worker errors.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border text-muted-foreground">
                    <th className="pb-1 pr-4 text-left font-medium">Worker</th>
                    <th className="pb-1 pr-4 text-left font-medium">Code</th>
                    <th className="pb-1 pr-4 text-left font-medium">Detail</th>
                    <th className="pb-1 text-left font-medium">When</th>
                  </tr>
                </thead>
                <tbody>
                  {health.recentErrors.map((e, idx) => (
                    <tr
                      key={`${e.workerId}-${idx}`}
                      className="border-b border-border/40 last:border-0"
                    >
                      <td className="py-1.5 pr-4 font-mono text-muted-foreground">{e.workerId}</td>
                      <td className="py-1.5 pr-4 font-mono text-amber-500">{e.code}</td>
                      <td
                        className="max-w-xs truncate py-1.5 pr-4 text-muted-foreground"
                        title={e.detail}
                      >
                        {e.detail}
                      </td>
                      <td className="py-1.5 tabular-nums text-muted-foreground">{timeAgo(e.at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

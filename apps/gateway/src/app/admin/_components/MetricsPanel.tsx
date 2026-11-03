'use client';
/**
 * MetricsPanel, read-only 24-hour stats and sparklines per session.
 *
 * Auto-refreshes every 30 seconds via setInterval. No step-up required.
 * British English throughout. No emoji.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowUpRight, ArrowDownLeft, AlertTriangle, Webhook } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { SessionSnapshot } from '../_types';
import type { AdminSessionMetrics } from '@hmddevs/protocol';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface MetricsPanelProps {
  sessions: SessionSnapshot[];
}

// ---------------------------------------------------------------------------
// Sparkline, inline SVG bar chart, 24 bars (one per hour).
// ---------------------------------------------------------------------------

function Sparkline({
  points,
  colour,
}: {
  points: { hour: number; count: number }[];
  colour: string;
}) {
  const max = Math.max(...points.map((p) => p.count), 1);
  const W = 300; // viewBox width
  const H = 40;
  const barW = W / points.length;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="w-full h-10" aria-hidden>
      {points.map((p, i) => {
        const barH = Math.max((p.count / max) * H, p.count > 0 ? 2 : 0);
        return (
          <rect
            key={p.hour}
            x={i * barW + 1}
            y={H - barH}
            width={barW - 2}
            height={barH}
            fill={colour}
            opacity={0.85}
          />
        );
      })}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Summary card
// ---------------------------------------------------------------------------

interface SummaryCardProps {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
}

function SummaryCard({ icon, label, value }: SummaryCardProps) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-2 py-5 px-5">
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
// MetricsPanel
// ---------------------------------------------------------------------------

export function MetricsPanel({ sessions }: MetricsPanelProps) {
  const defaultSessionId = useMemo(() => {
    const connected = sessions.find((s) => s.status === 'connected');
    return connected?.sessionId ?? sessions[0]?.sessionId ?? null;
  }, [sessions]);

  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(defaultSessionId);
  const [metrics, setMetrics] = useState<AdminSessionMetrics | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchMetrics = useCallback(async () => {
    if (!selectedSessionId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/sessions/${selectedSessionId}/metrics`, {
        credentials: 'include',
        cache: 'no-store',
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      setMetrics((await res.json()) as AdminSessionMetrics);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [selectedSessionId]);

  useEffect(() => {
    void fetchMetrics();
    const id = setInterval(() => void fetchMetrics(), 30_000);
    return () => clearInterval(id);
  }, [fetchMetrics]);

  // ---- Empty state: no sessions ----
  if (sessions.length === 0) {
    return (
      <section className="space-y-4">
        <div>
          <h2 className="text-base font-semibold tracking-tight">Metrics</h2>
          <p className="text-xs text-muted-foreground">
            24-hour message and webhook statistics per session.
          </p>
        </div>
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No sessions yet, create one in the Sessions tab.
          </CardContent>
        </Card>
      </section>
    );
  }

  // Derive a formatted time from cachedAt for the sparkline card footer.
  const cachedAtFormatted = metrics?.cachedAt
    ? new Date(metrics.cachedAt).toLocaleTimeString('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
    : null;

  return (
    <section className="space-y-4">
      {/* Panel header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold tracking-tight">Metrics</h2>
          <p className="text-xs text-muted-foreground">
            24-hour message and webhook statistics per session. Refreshes every 30 seconds.
          </p>
        </div>

        {/* Session selector, native <select> matches ConversationsPanel convention */}
        <select
          value={selectedSessionId ?? ''}
          onChange={(e) => setSelectedSessionId(e.target.value)}
          aria-label="Select session"
          className="flex h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
        >
          {sessions.map((s) => (
            <option key={s.sessionId} value={s.sessionId}>
              {s.label} ({s.sessionId})
            </option>
          ))}
        </select>
      </div>

      {/* Error state */}
      {error && (
        <div className="flex items-center gap-3 rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-muted-foreground">
          <span className="flex-1">Failed to load metrics: {error}</span>
          <Button variant="outline" size="sm" onClick={() => void fetchMetrics()}>
            Retry
          </Button>
        </div>
      )}

      {/* Summary cards row */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <SummaryCard
          icon={<ArrowUpRight className="h-3.5 w-3.5" />}
          label="Messages sent (24 h)"
          value={
            loading && !metrics ? (
              <div className="animate-pulse bg-muted rounded h-7 w-16" />
            ) : (
              (metrics?.messages.sent24h ?? ', ')
            )
          }
        />
        <SummaryCard
          icon={<ArrowDownLeft className="h-3.5 w-3.5" />}
          label="Messages received (24 h)"
          value={
            loading && !metrics ? (
              <div className="animate-pulse bg-muted rounded h-7 w-16" />
            ) : (
              (metrics?.messages.received24h ?? ', ')
            )
          }
        />
        <SummaryCard
          icon={<AlertTriangle className="h-3.5 w-3.5" />}
          label="Failed messages (24 h)"
          value={
            loading && !metrics ? (
              <div className="animate-pulse bg-muted rounded h-7 w-16" />
            ) : (
              <span
                className={cn(
                  metrics && metrics.messages.failed24h > 0 ? 'text-amber-500' : undefined,
                )}
              >
                {metrics?.messages.failed24h ?? ', '}
              </span>
            )
          }
        />
        <SummaryCard
          icon={<Webhook className="h-3.5 w-3.5" />}
          label="Webhooks delivered / failed"
          value={
            loading && !metrics ? (
              <div className="animate-pulse bg-muted rounded h-7 w-24" />
            ) : metrics ? (
              <span>
                {metrics.webhooks.delivered24h}
                <span className="text-muted-foreground mx-1 text-base font-normal">/</span>
                <span className={cn(metrics.webhooks.failed24h > 0 ? 'text-amber-500' : undefined)}>
                  {metrics.webhooks.failed24h}
                </span>
              </span>
            ) : (
              ', '
            )
          }
        />
      </div>

      {/* Sparkline card */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between gap-3">
            <CardTitle className="text-sm font-medium">Message activity, last 24 hours</CardTitle>
            {cachedAtFormatted && (
              <span className="text-[11px] text-muted-foreground tabular-nums">
                Cached at {cachedAtFormatted}
              </span>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4 pb-5">
          {loading && !metrics ? (
            <div className="space-y-3">
              <div className="animate-pulse bg-muted rounded h-10" />
              <div className="animate-pulse bg-muted rounded h-10" />
            </div>
          ) : metrics ? (
            <>
              {/* Sent sparkline */}
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">
                  Sent
                  <span className="ml-1 tabular-nums text-foreground">
                    ({metrics.messages.sent24h} total)
                  </span>
                </p>
                <Sparkline points={metrics.messages.sentSparkline} colour="hsl(217 91% 60%)" />
              </div>

              {/* Received sparkline */}
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">
                  Received
                  <span className="ml-1 tabular-nums text-foreground">
                    ({metrics.messages.received24h} total)
                  </span>
                </p>
                <Sparkline points={metrics.messages.receivedSparkline} colour="hsl(142 71% 45%)" />
              </div>

              {/* Failed context, text only, no third sparkline */}
              {metrics.messages.failed24h > 0 && (
                <p className="text-xs text-amber-500">
                  {metrics.messages.failed24h} message{metrics.messages.failed24h === 1 ? '' : 's'}{' '}
                  failed in the last 24 hours.
                </p>
              )}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">No data available.</p>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

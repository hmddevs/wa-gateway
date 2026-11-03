'use client';
/**
 * WorkersManagementPanel, list of all enrolled workers with health signals,
 * and per-row Delete action gated behind WebAuthn step-up.
 *
 * Reuses the same step-up gate pattern as ApiKeysPanel and SessionsPanel:
 *   1. Check `stepUpDone` before opening the destructive confirm.
 *   2. If not done, call `onStepUpRequired()`, parent navigates to Security tab.
 *   3. On confirm, call DELETE /api/admin/workers/:id, then refresh.
 *
 * Auto-refreshes every 15 s (between Sessions 6 s and Metrics 30 s).
 * British English throughout.
 */
import { useCallback, useEffect, useState } from 'react';
import { Cpu, RefreshCw, Trash2, AlertTriangle, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { timeAgo } from '../_types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorkerView {
  workerId: string;
  status: 'offline' | 'pairing' | 'connected' | 'degraded';
  online: boolean;
  lastHeartbeatAt: string | null;
  connectedAt: string | null;
  deviceName: string | null;
  hostname: string | null;
  version: string | null;
  phoneE164: string | null;
  queueDepth: number | null;
  lastError: { code: string; detail: string; at: string } | null;
}

interface WorkersManagementPanelProps {
  stepUpDone: boolean;
  onStepUpRequired: () => void;
}

// ---------------------------------------------------------------------------
// Status badge, mirrors SessionsPanel dot + label pattern.
// ---------------------------------------------------------------------------

const WORKER_STATUS_DOT: Record<WorkerView['status'], string> = {
  connected: 'bg-emerald-500',
  pairing: 'bg-amber-500',
  degraded: 'bg-orange-500',
  offline: 'bg-destructive',
};

const WORKER_STATUS_LABEL: Record<WorkerView['status'], string> = {
  connected: 'Connected',
  pairing: 'Pairing',
  degraded: 'Degraded',
  offline: 'Offline',
};

interface StatusBadgeProps {
  status: WorkerView['status'];
  online: boolean;
  lastHeartbeatAt: string | null;
}

function WorkerStatusBadge({ status, online, lastHeartbeatAt }: StatusBadgeProps) {
  // Heartbeat staleness check, >60 s means stale regardless of status field.
  const isStale =
    online && lastHeartbeatAt !== null && Date.now() - new Date(lastHeartbeatAt).getTime() > 60_000;

  const dotClass = isStale ? 'bg-amber-500' : online ? WORKER_STATUS_DOT[status] : 'bg-destructive';

  const label = isStale ? 'Stale' : WORKER_STATUS_LABEL[status];

  const wrapperClass = isStale
    ? 'bg-amber-500/10 border-amber-500/40'
    : online && status === 'connected'
      ? 'bg-muted/40'
      : 'bg-destructive/10 border-destructive/40';

  const textClass = isStale
    ? 'text-amber-600 dark:text-amber-400'
    : online && status === 'connected'
      ? 'text-foreground'
      : 'text-destructive';

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-xs font-medium',
        wrapperClass,
      )}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', dotClass)} />
      <span className={textClass}>{label}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Heartbeat age cell, highlights when stale.
// ---------------------------------------------------------------------------

function HeartbeatAge({ iso }: { iso: string | null }) {
  if (!iso) return <span className="text-muted-foreground">, </span>;
  const ageMs = Date.now() - new Date(iso).getTime();
  const stale = ageMs > 60_000;
  return (
    <span className={cn('tabular-nums', stale ? 'text-amber-500' : 'text-foreground')}>
      {timeAgo(iso)}
      {stale && <AlertTriangle className="ml-1 inline h-3 w-3" aria-label="Heartbeat stale" />}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Last error cell, truncated inline; title for full detail.
// ---------------------------------------------------------------------------

function LastErrorCell({ lastError }: { lastError: WorkerView['lastError'] }) {
  if (!lastError) return <span className="text-muted-foreground">, </span>;
  return (
    <span
      title={`${lastError.code}: ${lastError.detail} (${timeAgo(lastError.at)})`}
      className="inline-flex cursor-default items-center gap-1 text-amber-500"
    >
      <span className="font-mono">{lastError.code}</span>
      <span className="text-muted-foreground">{timeAgo(lastError.at)}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------

export function WorkersManagementPanel({
  stepUpDone,
  onStepUpRequired,
}: WorkersManagementPanelProps) {
  const [workers, setWorkers] = useState<WorkerView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<WorkerView | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const fetchWorkers = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/workers', {
        credentials: 'include',
        cache: 'no-store',
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { workers: WorkerView[] };
      setWorkers(data.workers);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchWorkers();
    const id = setInterval(() => void fetchWorkers(), 15_000);
    return () => clearInterval(id);
  }, [fetchWorkers]);

  function handleDeleteClick(worker: WorkerView) {
    if (!stepUpDone) {
      onStepUpRequired();
      return;
    }
    setDeleteTarget(worker);
  }

  async function handleDeleteConfirm() {
    if (!deleteTarget) return;
    setDeletingId(deleteTarget.workerId);
    try {
      const res = await fetch(`/api/admin/workers/${encodeURIComponent(deleteTarget.workerId)}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      toast.success(
        `Worker "${deleteTarget.workerId}" removed. Row will reappear if the worker is still live.`,
      );
      setDeleteTarget(null);
      await fetchWorkers();
    } catch (err) {
      toast.error(`Delete failed: ${(err as Error).message}`);
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <section className="space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold tracking-tight">Workers</h2>
          <p className="text-xs text-muted-foreground">
            All enrolled worker devices. Refreshes every 15 seconds. A deleted row reappears on the
            worker&apos;s next heartbeat if the process is still running.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void fetchWorkers()} disabled={loading}>
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
          Refresh
        </Button>
      </div>

      {/* Error banner */}
      {error && (
        <div className="flex items-center gap-3 rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-muted-foreground">
          <span className="flex-1">Failed to load workers: {error}</span>
          <Button variant="outline" size="sm" onClick={() => void fetchWorkers()}>
            Retry
          </Button>
        </div>
      )}

      {/* Workers table */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <Cpu className="h-4 w-4 text-primary" />
            Enrolled workers
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {loading && workers.length === 0 ? (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : workers.length === 0 ? (
            <p className="px-6 py-10 text-center text-sm text-muted-foreground">
              No workers found. Enrol a worker using the provisioning section below.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Worker ID</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Heartbeat</TableHead>
                    <TableHead>Phone</TableHead>
                    <TableHead>Queue</TableHead>
                    <TableHead>Version</TableHead>
                    <TableHead>Host</TableHead>
                    <TableHead>Last error</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {workers.map((w) => (
                    <TableRow key={w.workerId}>
                      <TableCell className="font-mono text-xs font-medium">
                        {w.workerId}
                        {w.deviceName && (
                          <span className="block text-[10px] font-normal text-muted-foreground">
                            {w.deviceName}
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        <WorkerStatusBadge
                          status={w.status}
                          online={w.online}
                          lastHeartbeatAt={w.lastHeartbeatAt}
                        />
                      </TableCell>
                      <TableCell className="text-xs">
                        <HeartbeatAge iso={w.lastHeartbeatAt} />
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {w.phoneE164 ?? ', '}
                      </TableCell>
                      <TableCell className="tabular-nums text-xs">
                        {w.queueDepth !== null ? (
                          <span
                            className={cn(w.queueDepth > 0 ? 'text-amber-500' : 'text-foreground')}
                          >
                            {w.queueDepth}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">, </span>
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {w.version ?? ', '}
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {w.hostname ?? ', '}
                      </TableCell>
                      <TableCell className="text-xs">
                        <LastErrorCell lastError={w.lastError} />
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-destructive hover:text-destructive"
                          title={`Remove worker ${w.workerId}`}
                          aria-label={`Remove worker ${w.workerId}`}
                          disabled={deletingId === w.workerId}
                          onClick={() => handleDeleteClick(w)}
                        >
                          {deletingId === w.workerId ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Trash2 className="h-3.5 w-3.5" />
                          )}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Delete confirm, AlertDialog mirrors ApiKeysPanel revoke pattern exactly. */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove worker?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the <span className="font-mono">{deleteTarget?.workerId}</span> row from
              worker_state. If the worker process is still running, the row will reappear
              automatically on its next heartbeat. This is safe to use to clean up ghost or stale
              entries.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void handleDeleteConfirm()}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Remove worker
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

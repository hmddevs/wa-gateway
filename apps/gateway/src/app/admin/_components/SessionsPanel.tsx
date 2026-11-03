'use client';
/**
 * Sessions panel, grid of session cards with status, pairing QR, and
 * destructive controls. Polling and lifecycle behaviour preserved from the
 * pre-shadcn implementation.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Plus,
  RefreshCw,
  Trash2,
  Smartphone,
  ChevronDown,
  ChevronUp,
  Loader2,
  X,
  UserX,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';
import {
  type SessionSnapshot,
  type OptOutView,
  STATUS_DOT,
  STATUS_LABEL,
  SESSION_ID_RE,
  fmtDate,
  timeAgo,
} from '../_types';
import { deriveDisplayStatus, type LivenessState } from '../_lib/liveness';
import { ErasureDialog } from './ErasureDialog';

interface SessionsPanelProps {
  sessions: SessionSnapshot[];
  defaultWorkerId: string;
  stepUpDone: boolean;
  onStepUpRequired: () => void;
  onMutated: () => Promise<void> | void;
}

interface StatusBadgeProps {
  rawStatus: SessionSnapshot['status'];
  lastHeartbeatAt: string | null;
  liveness: LivenessState;
}

function StatusBadge({ rawStatus, lastHeartbeatAt, liveness }: StatusBadgeProps) {
  const displayInfo = deriveDisplayStatus(rawStatus, lastHeartbeatAt);
  const displayStatusText = displayInfo.displayStatus;

  // Determine badge colour based on liveness state.
  const getBgColor = () => {
    switch (liveness) {
      case 'online':
        // When online, use the status-specific colour (from rawStatus).
        return STATUS_DOT[rawStatus];
      case 'stale':
        return 'bg-amber-500';
      case 'offline':
        return 'bg-destructive';
    }
  };

  const bgColor = getBgColor();
  // When stale or offline, override the status label with the liveness-derived label.
  const label = liveness === 'online' ? STATUS_LABEL[rawStatus] : displayStatusText;

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-xs font-medium',
        // Dynamic background based on liveness state.
        liveness === 'online'
          ? 'bg-muted/40'
          : liveness === 'stale'
            ? 'bg-amber-500/10 border-amber-500/40'
            : 'bg-destructive/10 border-destructive/40',
      )}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', bgColor)} />
      <span
        className={cn(
          liveness === 'online'
            ? 'text-foreground'
            : liveness === 'stale'
              ? 'text-amber-600 dark:text-amber-400'
              : 'text-destructive',
        )}
      >
        {label}
      </span>
    </span>
  );
}

function HistorySyncBadge({
  sessionId,
  progress,
  lastHeartbeatAt,
}: {
  sessionId: string;
  progress: SessionSnapshot['historySyncProgress'];
  lastHeartbeatAt: string | null;
}) {
  const lsKey = `history-sync-dismissed:${sessionId}`;
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(lsKey) === '1';
    } catch {
      return false;
    }
  });
  const prevIsLatest = useRef(progress?.isLatest);

  // Reset dismiss when a new sync starts (isLatest flips back to false).
  useEffect(() => {
    if (progress && !progress.isLatest && prevIsLatest.current) {
      setDismissed(false);
      try {
        localStorage.removeItem(lsKey);
      } catch {
        /* ignore */
      }
    }
    prevIsLatest.current = progress?.isLatest;
  }, [progress, lsKey]);

  if (!progress || dismissed) return null;
  // Auto-hide once sync completes, no need to keep showing the badge.
  if (progress.isLatest) return null;

  function dismiss() {
    setDismissed(true);
    try {
      localStorage.setItem(lsKey, '1');
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="flex flex-col gap-0.5">
      <Badge
        variant="outline"
        className="border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400 text-[11px] font-medium pr-1"
      >
        <span className="animate-pulse mr-1">&bull;</span>
        Syncing history&hellip; {progress.received.toLocaleString()} messages
        <button
          type="button"
          aria-label="Dismiss sync badge"
          onClick={dismiss}
          className="ml-1 rounded hover:opacity-70 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <X className="h-2.5 w-2.5" />
        </button>
      </Badge>
      <span className="text-[10px] text-muted-foreground pl-0.5">
        {lastHeartbeatAt ? `Last batch: ${timeAgo(lastHeartbeatAt)}` : 'Waiting for batch…'}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Opt-outs section, lazily loaded per session card
// ---------------------------------------------------------------------------

const E164_RE = /^\+[1-9]\d{6,14}$/;

interface OptOutsSectionProps {
  sessionId: string;
}

function OptOutsSection({ sessionId }: OptOutsSectionProps) {
  const [expanded, setExpanded] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [optOuts, setOptOuts] = useState<OptOutView[]>([]);
  const [addPhone, setAddPhone] = useState('');
  const [addPhoneError, setAddPhoneError] = useState<string | null>(null);
  const [addBusy, setAddBusy] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/sessions/${sessionId}/optouts`, {
        credentials: 'include',
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(await res.text());
      const data = (await res.json()) as { optOuts: OptOutView[] };
      setOptOuts(data.optOuts);
      setLoaded(true);
    } catch (err) {
      toast.error(`Failed to load opt-outs: ${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  }

  function handleToggle() {
    const next = !expanded;
    setExpanded(next);
    if (next && !loaded) void load();
  }

  async function handleRemove(phone: string) {
    try {
      const res = await fetch(
        `/api/admin/sessions/${sessionId}/optouts/${encodeURIComponent(phone)}`,
        { method: 'DELETE', credentials: 'include' },
      );
      if (!res.ok) throw new Error(await res.text());
      setOptOuts((prev) => prev.filter((o) => o.phone !== phone));
      toast.success(`Opt-out removed for ${phone}`);
    } catch (err) {
      toast.error(`Remove failed: ${(err as Error).message}`);
    }
  }

  function validatePhone(value: string) {
    if (!E164_RE.test(value)) {
      setAddPhoneError('Must be E.164 format, e.g. +447700900123');
    } else {
      setAddPhoneError(null);
    }
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!E164_RE.test(addPhone)) {
      validatePhone(addPhone);
      return;
    }
    setAddBusy(true);
    try {
      const res = await fetch(`/api/admin/sessions/${sessionId}/optouts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ phone: addPhone }),
      });
      if (!res.ok) throw new Error(await res.text());
      const newEntry: OptOutView = {
        phone: addPhone,
        source: 'admin',
        createdAt: new Date().toISOString(),
      };
      setOptOuts((prev) => [newEntry, ...prev]);
      setAddPhone('');
      setAddPhoneError(null);
      toast.success(`${addPhone} blocked`);
    } catch (err) {
      toast.error(`Block failed: ${(err as Error).message}`);
    } finally {
      setAddBusy(false);
    }
  }

  return (
    <div className="rounded-md border border-border/60 bg-muted/20">
      <button
        type="button"
        onClick={handleToggle}
        className="flex w-full items-center justify-between px-3 py-2 text-xs font-medium text-foreground hover:bg-muted/40 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded-md"
      >
        <span className="flex items-center gap-1.5">
          Opt-outs
          {loaded && (
            <span className="inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-muted px-1 text-[10px] font-semibold tabular-nums">
              {optOuts.length}
            </span>
          )}
        </span>
        {expanded ? (
          <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        )}
      </button>

      {expanded && (
        <div className="border-t border-border/60 px-3 pb-3 pt-2 space-y-3">
          {loading ? (
            <div className="flex items-center justify-center py-4">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          ) : optOuts.length === 0 ? (
            <p className="text-xs text-muted-foreground py-2">No opt-outs for this session.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border text-muted-foreground">
                    <th className="pb-1 pr-3 text-left font-medium">Phone</th>
                    <th className="pb-1 pr-3 text-left font-medium">Source</th>
                    <th className="pb-1 pr-3 text-left font-medium">Keyword</th>
                    <th className="pb-1 pr-3 text-left font-medium">Date</th>
                    <th className="pb-1 text-right font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {optOuts.map((o) => (
                    <tr key={o.phone} className="border-b border-border/40 last:border-0">
                      <td className="py-1 pr-3 font-mono tabular-nums">{o.phone}</td>
                      <td className="py-1 pr-3 capitalize">{o.source}</td>
                      <td className="py-1 pr-3 text-muted-foreground">{o.keyword ?? ', '}</td>
                      <td className="py-1 pr-3 tabular-nums text-muted-foreground">
                        {fmtDate(o.createdAt)}
                      </td>
                      <td className="py-1 text-right">
                        <button
                          type="button"
                          onClick={() => void handleRemove(o.phone)}
                          aria-label={`Remove opt-out for ${o.phone}`}
                          className="rounded p-0.5 text-muted-foreground hover:text-destructive focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Add opt-out row */}
          <form onSubmit={handleAdd} className="space-y-1.5">
            <div className="flex items-start gap-2">
              <div className="flex-1 space-y-1">
                <Input
                  value={addPhone}
                  onChange={(e) => {
                    setAddPhone(e.target.value);
                    if (addPhoneError) validatePhone(e.target.value);
                  }}
                  placeholder="+447700900123"
                  className="h-7 font-mono text-xs"
                />
                {addPhoneError && <p className="text-[11px] text-destructive">{addPhoneError}</p>}
              </div>
              <Button type="submit" size="sm" disabled={addBusy} className="h-7 shrink-0">
                {addBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Block'}
              </Button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

interface SessionCardProps {
  session: SessionSnapshot;
  stepUpDone: boolean;
  onStepUpRequired: () => void;
  onMutated: () => Promise<void> | void;
}

function SessionCard({ session, stepUpDone, onStepUpRequired, onMutated }: SessionCardProps) {
  const [liveSession, setLiveSession] = useState<SessionSnapshot>(session);
  const [busy, setBusy] = useState(false);
  const [showStopConfirm, setShowStopConfirm] = useState(false);
  const [showQr, setShowQr] = useState(false);
  // Read-receipt toggle, defaults true when the field is absent on older docs.
  const [readReceiptsBusy, setReadReceiptsBusy] = useState(false);
  const sendReadReceipts = liveSession.conversation?.sendReadReceipts ?? true;

  // Liveness state, triggers re-render when heartbeat age crosses thresholds.
  const [liveness, setLiveness] = useState<LivenessState>(() => {
    const { state } = deriveDisplayStatus(session.status, session.lastHeartbeatAt);
    return state;
  });

  // Sync if parent list refresh updates the session prop.
  useEffect(() => {
    setLiveSession(session);
    const { state } = deriveDisplayStatus(session.status, session.lastHeartbeatAt);
    setLiveness(state);
  }, [session]);

  // Per-session 4 s polling while pairing, preserves QR-update cadence.
  useEffect(() => {
    if (liveSession.status !== 'pairing') return;
    const id = setInterval(async () => {
      try {
        const res = await fetch(`/api/admin/sessions/${liveSession.sessionId}`, {
          cache: 'no-store',
        });
        if (res.ok) {
          const data = (await res.json()) as { session: SessionSnapshot };
          setLiveSession(data.session);
        }
      } catch {
        /* ignore transient fetch errors */
      }
    }, 4_000);
    return () => clearInterval(id);
  }, [liveSession.sessionId, liveSession.status]);

  // Auto-refresh liveness every 10 seconds, ensures badges update when heartbeat age
  // crosses the 60s and 300s thresholds without requiring fresh data from the server.
  useEffect(() => {
    const id = setInterval(() => {
      const { state } = deriveDisplayStatus(liveSession.status, liveSession.lastHeartbeatAt);
      setLiveness(state);
    }, 10_000);
    return () => clearInterval(id);
  }, [liveSession.status, liveSession.lastHeartbeatAt]);

  // Auto-open the QR dialog whenever a session enters pairing with a QR
  // payload, and auto-close it when the session transitions away.
  useEffect(() => {
    if (liveSession.status === 'pairing' && liveSession.pairing?.qr) {
      setShowQr(true);
    } else if (liveSession.status === 'connected') {
      setShowQr(false);
    }
  }, [liveSession.status, liveSession.pairing?.qr]);

  async function toggleReadReceipts(next: boolean) {
    if (readReceiptsBusy || next === sendReadReceipts) return;
    setReadReceiptsBusy(true);
    // Optimistic update.
    setLiveSession((prev) => ({
      ...prev,
      conversation: {
        ...(prev.conversation ?? { sendReadReceipts: true }),
        sendReadReceipts: next,
      },
    }));
    try {
      const res = await fetch(`/api/admin/sessions/${liveSession.sessionId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversation: { sendReadReceipts: next } }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = (await res.json()) as { session: SessionSnapshot };
      setLiveSession(data.session);
      toast.success(next ? 'Read receipts enabled' : 'Read receipts disabled');
    } catch (err) {
      // Revert.
      setLiveSession((prev) => ({
        ...prev,
        conversation: {
          ...(prev.conversation ?? { sendReadReceipts: true }),
          sendReadReceipts: !next,
        },
      }));
      toast.error(`Toggle failed: ${(err as Error).message}`);
    } finally {
      setReadReceiptsBusy(false);
    }
  }

  async function performDelete() {
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/sessions/${liveSession.sessionId}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error(await res.text());
      toast.success(`Session ${liveSession.sessionId} stopped`);
      await onMutated();
    } catch (err) {
      toast.error(`Stop failed: ${(err as Error).message}`);
    } finally {
      setBusy(false);
      setShowStopConfirm(false);
    }
  }

  async function handleRestart() {
    if (!stepUpDone) {
      onStepUpRequired();
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/sessions/${liveSession.sessionId}/control`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'restart' }),
      });
      if (!res.ok) throw new Error(await res.text());
      toast.success(`Session ${liveSession.sessionId} restarting`);
      await onMutated();
    } catch (err) {
      toast.error(`Restart failed: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  function handleStopClick() {
    if (!stepUpDone) {
      onStepUpRequired();
      return;
    }
    setShowStopConfirm(true);
  }

  const qrSrc = liveSession.pairing?.qr
    ? liveSession.pairing.qr.startsWith('data:')
      ? liveSession.pairing.qr
      : `data:image/png;base64,${liveSession.pairing.qr}`
    : null;

  return (
    <>
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 space-y-1">
              <CardTitle className="font-mono text-sm">{liveSession.sessionId}</CardTitle>
              <p className="truncate text-xs text-muted-foreground">{liveSession.label}</p>
            </div>
            <div className="flex flex-col items-end gap-1.5">
              <StatusBadge
                rawStatus={liveSession.status}
                lastHeartbeatAt={liveSession.lastHeartbeatAt}
                liveness={liveness}
              />
              <HistorySyncBadge
                sessionId={liveSession.sessionId}
                progress={liveSession.historySyncProgress}
                lastHeartbeatAt={liveSession.lastHeartbeatAt}
              />
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <dl className="space-y-1 text-xs text-muted-foreground">
            {liveSession.phoneE164 ? (
              <div className="flex justify-between gap-2">
                <dt>Phone</dt>
                <dd className="font-mono tabular-nums text-foreground">{liveSession.phoneE164}</dd>
              </div>
            ) : null}
            <div className="flex justify-between gap-2">
              <dt>Last heartbeat</dt>
              <dd className="tabular-nums text-foreground">
                {fmtDate(liveSession.lastHeartbeatAt)}
              </dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt>Worker</dt>
              <dd className="font-mono text-foreground">{liveSession.workerId}</dd>
            </div>
          </dl>

          <div className="flex items-start gap-3 rounded-md border border-border/60 bg-muted/30 px-3 py-2">
            <Checkbox
              id={`read-receipts-${liveSession.sessionId}`}
              checked={sendReadReceipts}
              disabled={readReceiptsBusy}
              onCheckedChange={(c) => void toggleReadReceipts(c === true)}
              className="mt-0.5"
            />
            <div className="min-w-0 flex-1 space-y-0.5">
              <Label
                htmlFor={`read-receipts-${liveSession.sessionId}`}
                className="cursor-pointer text-xs font-medium"
              >
                Send read receipts
              </Label>
              <p className="text-[11px] leading-snug text-muted-foreground">
                When off, the worker stops marking inbound messages as read, senders see only a
                single grey tick.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap gap-2 pt-1">
            {liveSession.status === 'pairing' && qrSrc ? (
              <Button size="sm" variant="outline" onClick={() => setShowQr(true)}>
                <Smartphone />
                Show QR
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              onClick={handleRestart}
              disabled={busy || liveSession.status === 'stopped'}
            >
              <RefreshCw />
              Restart
            </Button>
            <Button size="sm" variant="destructive" onClick={handleStopClick} disabled={busy}>
              <Trash2 />
              Stop
            </Button>
          </div>

          <OptOutsSection sessionId={liveSession.sessionId} />
        </CardContent>
      </Card>

      {/* Pairing QR dialog */}
      <Dialog open={showQr} onOpenChange={setShowQr}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Pair WhatsApp</DialogTitle>
            <DialogDescription>
              Open WhatsApp on your phone, go to Settings &rsaquo; Linked Devices, and scan the code
              below.
            </DialogDescription>
          </DialogHeader>
          {qrSrc ? (
            <div className="flex justify-center rounded-md border bg-white p-4">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={qrSrc} alt="WhatsApp pairing QR" className="h-56 w-56" />
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Waiting for the worker to emit a QR…</p>
          )}
          <p className="text-center font-mono text-xs text-muted-foreground">
            {liveSession.sessionId}
          </p>
        </DialogContent>
      </Dialog>

      {/* Confirm stop */}
      <AlertDialog open={showStopConfirm} onOpenChange={setShowStopConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop session {liveSession.sessionId}?</AlertDialogTitle>
            <AlertDialogDescription>
              This stops the Baileys connection and removes the session permanently. Future messages
              on this session will fail until a new one is created.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void performDelete();
              }}
              disabled={busy}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {busy ? 'Stopping…' : 'Stop session'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

interface CreateSessionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultWorkerId: string;
  stepUpDone: boolean;
  onCreated: () => Promise<void> | void;
}

interface WorkerOption {
  workerId: string;
  status: 'offline' | 'pairing' | 'connected' | 'degraded';
  online: boolean;
  lastHeartbeatAt: string | null;
  deviceName: string | null;
  hostname: string | null;
}

function CreateSessionDialog({
  open,
  onOpenChange,
  defaultWorkerId,
  stepUpDone,
  onCreated,
}: CreateSessionDialogProps) {
  const [sessionId, setSessionId] = useState('');
  const [label, setLabel] = useState('');
  const [workerId, setWorkerId] = useState(defaultWorkerId);
  const [workers, setWorkers] = useState<WorkerOption[] | null>(null);
  const [workersError, setWorkersError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [idError, setIdError] = useState<string | null>(null);

  // Reset form when dialog closes.
  useEffect(() => {
    if (!open) {
      setSessionId('');
      setLabel('');
      setWorkerId(defaultWorkerId);
      setWorkers(null);
      setWorkersError(null);
      setError(null);
      setIdError(null);
      setBusy(false);
    }
  }, [open, defaultWorkerId]);

  // Fetch the live worker list when the dialog opens. The endpoint always
  // includes the env-default workerId even if it has never heartbeated, so
  // a brand-new install can still pick its own worker.
  useEffect(() => {
    if (!open || !stepUpDone) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/admin/workers');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { workers: WorkerOption[] };
        if (cancelled) return;
        setWorkers(body.workers);
        // Prefer the freshest online worker; fall back to the env default.
        const firstOnline = body.workers.find((w) => w.online);
        setWorkerId(firstOnline?.workerId ?? defaultWorkerId);
      } catch (err) {
        if (cancelled) return;
        setWorkersError((err as Error).message);
        setWorkers([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, stepUpDone, defaultWorkerId]);

  function validateId(value: string) {
    if (!SESSION_ID_RE.test(value)) {
      setIdError('2 to 32 lowercase letters, digits, or hyphens');
    } else {
      setIdError(null);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!stepUpDone) return;
    if (!SESSION_ID_RE.test(sessionId)) {
      validateId(sessionId);
      return;
    }
    if (!workerId || (workers !== null && workers.length === 0)) {
      setError('No worker available to host this session.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, label, workerId }),
      });
      if (!res.ok) throw new Error(await res.text());
      toast.success(`Session ${sessionId} created`);
      await onCreated();
      onOpenChange(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create session</DialogTitle>
          <DialogDescription>
            Provision a new Baileys session on a worker. The worker will emit a pairing QR shortly
            after creation.
          </DialogDescription>
        </DialogHeader>

        {!stepUpDone ? (
          <p className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
            Step-up verification required. Use the Security panel to re-verify, then try again.
          </p>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="new-session-id">Session ID</Label>
              <Input
                id="new-session-id"
                value={sessionId}
                onChange={(e) => {
                  setSessionId(e.target.value);
                  validateId(e.target.value);
                }}
                placeholder="e.g. session-a"
                className="font-mono"
                required
                autoFocus
              />
              {idError ? <p className="text-xs text-destructive">{idError}</p> : null}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="new-session-label">Label</Label>
              <Input
                id="new-session-label"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="e.g. Notifications worker"
                required
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="new-session-worker">Worker</Label>
              {workers === null ? (
                <p className="text-xs text-muted-foreground">Loading workers…</p>
              ) : workers.length === 0 ? (
                <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-400">
                  {workersError
                    ? `Couldn't load worker list (${workersError}). Refresh and try again.`
                    : 'No workers registered. Install at least one worker before creating a session.'}
                </p>
              ) : (
                <>
                  <select
                    id="new-session-worker"
                    value={workerId}
                    onChange={(e) => setWorkerId(e.target.value)}
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    required
                  >
                    {workers.map((w) => {
                      const lastSeen = w.lastHeartbeatAt
                        ? `${Math.max(0, Math.floor((Date.now() - new Date(w.lastHeartbeatAt).getTime()) / 1000))}s ago`
                        : 'never';
                      const dot = w.online ? '🟢' : w.status === 'pairing' ? '🟡' : '⚪️';
                      const label = w.deviceName ?? w.hostname ?? w.workerId;
                      return (
                        <option key={w.workerId} value={w.workerId}>
                          {dot} {w.workerId}
                          {label !== w.workerId ? `, ${label}` : ''}
                          {' · last seen '}
                          {lastSeen}
                        </option>
                      );
                    })}
                  </select>
                  <p className="text-xs text-muted-foreground">
                    {workers.some((w) => w.online)
                      ? 'Online workers are healthy and will pair immediately.'
                      : 'No worker is currently online, the session will queue and pair when one comes back.'}
                  </p>
                </>
              )}
            </div>

            {error ? (
              <p className="rounded-md border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive">
                {error}
              </p>
            ) : null}

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={busy}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={busy || !!idError}>
                {busy ? 'Creating…' : 'Create session'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function SessionsPanel({
  sessions,
  defaultWorkerId,
  stepUpDone,
  onStepUpRequired,
  onMutated,
}: SessionsPanelProps) {
  const [showCreate, setShowCreate] = useState(false);
  const [eraseSessionId, setEraseSessionId] = useState<string | null>(null);
  const [eraseSessionTarget, setEraseSessionTarget] = useState<string>(
    sessions[0]?.sessionId ?? '',
  );

  const handleCreatedRefresh = useCallback(async () => {
    await onMutated();
  }, [onMutated]);

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold tracking-tight">Sessions</h2>
          <p className="text-xs text-muted-foreground">
            One Baileys connection per row. Pair from WhatsApp &rsaquo; Linked Devices.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {sessions.length > 0 && (
            <>
              {sessions.length > 1 && (
                <select
                  aria-label="Session to erase contact data from"
                  value={eraseSessionTarget}
                  onChange={(e) => setEraseSessionTarget(e.target.value)}
                  className="h-8 rounded-md border border-input bg-transparent px-2 text-xs shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  {sessions.map((s) => (
                    <option key={s.sessionId} value={s.sessionId}>
                      {s.label} ({s.sessionId})
                    </option>
                  ))}
                </select>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  if (!stepUpDone) {
                    onStepUpRequired();
                    return;
                  }
                  setEraseSessionId(eraseSessionTarget);
                }}
              >
                <UserX />
                Erase contact data
              </Button>
            </>
          )}
          <Button
            size="sm"
            onClick={() => {
              if (!stepUpDone) {
                onStepUpRequired();
                return;
              }
              setShowCreate(true);
            }}
          >
            <Plus />
            New session
          </Button>
        </div>
      </div>

      {sessions.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No sessions yet. Create one to connect a worker.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {sessions.map((s) => (
            <SessionCard
              key={s.sessionId}
              session={s}
              stepUpDone={stepUpDone}
              onStepUpRequired={onStepUpRequired}
              onMutated={handleCreatedRefresh}
            />
          ))}
        </div>
      )}

      <CreateSessionDialog
        open={showCreate}
        onOpenChange={setShowCreate}
        defaultWorkerId={defaultWorkerId}
        stepUpDone={stepUpDone}
        onCreated={handleCreatedRefresh}
      />

      <ErasureDialog
        open={eraseSessionId !== null}
        onClose={() => setEraseSessionId(null)}
        sessionId={eraseSessionId ?? ''}
        stepUpDone={stepUpDone}
        onStepUpRequired={onStepUpRequired}
      />
    </section>
  );
}

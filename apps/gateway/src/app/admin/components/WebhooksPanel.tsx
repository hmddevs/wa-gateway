'use client';
/**
 * Webhooks panel, admin UI for webhook route management.
 *
 * Mounted inside AdminClient. Receives initial route data from the server page
 * and operates entirely via fetch against /v1/admin/webhooks.
 *
 * Refactored onto shadcn primitives (Card, Dialog, AlertDialog, Tabs, Table,
 * Button, Input, Checkbox, Badge). All fetch URLs, payloads, and lifecycle
 * behaviour preserved.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Plus,
  Pencil,
  Send,
  Trash2,
  Copy,
  Check,
  ShieldAlert,
  CircleCheck,
  CircleX,
  CircleDashed,
} from 'lucide-react';
import { toast } from 'sonner';
import type { WebhookEventType, WebhookRouteScope } from '@hmddevs/protocol';
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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type { WebhookEventType, WebhookRouteScope };

/** Stripped public view, secret fields omitted by server before passing as props. */
export interface WebhookRouteView {
  routeId: string;
  scope: WebhookRouteScope;
  url: string;
  events: WebhookEventType[];
  active: boolean;
  description: string | null;
  secretFingerprint: string;
  createdAt: string;
  createdBy: string;
  lastDeliveryAt: string | null;
  lastDeliveryStatus: 'sent' | 'failed' | null;
  lastDeliveryHttpStatus: number | null;
  revokedAt: string | null;
}

export interface ApiKeyOption {
  keyId: string;
  label: string;
  sessionId: string;
}

export interface SessionOption {
  sessionId: string;
  label: string;
}

interface WebhooksPanelProps {
  initialRoutes: WebhookRouteView[];
  apiKeys: ApiKeyOption[];
  sessions: SessionOption[];
  stepUpDone: boolean;
  onStepUpRequired: () => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ALL_EVENT_TYPES: WebhookEventType[] = [
  'message.queued',
  'message.sent',
  'message.delivered',
  'message.read',
  'message.failed',
  'inbound.received',
  'webhook.test',
];

const MESSAGE_EVENTS: WebhookEventType[] = [
  'message.queued',
  'message.sent',
  'message.delivered',
  'message.read',
  'message.failed',
];

const INBOUND_EVENTS: WebhookEventType[] = ['inbound.received'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncateUrl(url: string, max = 52): string {
  if (url.length <= max) return url;
  return url.slice(0, max) + '…';
}

function timeAgo(iso: string | null): string {
  if (!iso) return ', ';
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function scopeLabel(
  scope: WebhookRouteScope,
  apiKeys: ApiKeyOption[],
  sessions: SessionOption[],
): string {
  if (scope.kind === 'apiKey') {
    const k = apiKeys.find((a) => a.keyId === scope.apiKeyId);
    return k ? `Key: ${k.label}` : `Key: ${scope.apiKeyId.slice(0, 12)}…`;
  }
  const s = sessions.find((se) => se.sessionId === scope.sessionId);
  return s ? `Session: ${s.label}` : `Session: ${scope.sessionId}`;
}

// ---------------------------------------------------------------------------
// Event chip, compact, neutral pill
// ---------------------------------------------------------------------------

function EventChip({ event }: { event: WebhookEventType }) {
  return (
    <span className="inline-flex items-center rounded border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] leading-none text-muted-foreground">
      {event}
    </span>
  );
}

// ---------------------------------------------------------------------------
// EventPicker, shared between Create and Edit dialogs
// ---------------------------------------------------------------------------

interface EventPickerProps {
  events: WebhookEventType[];
  setEvents: (next: WebhookEventType[]) => void;
}

function EventPicker({ events, setEvents }: EventPickerProps) {
  function toggleEvent(ev: WebhookEventType) {
    setEvents(events.includes(ev) ? events.filter((e) => e !== ev) : [...events, ev]);
  }

  return (
    <div className="space-y-2 rounded-md border bg-muted/20 p-3">
      <div className="flex flex-wrap gap-1.5">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-6 px-2 text-[11px]"
          onClick={() => setEvents([...ALL_EVENT_TYPES])}
        >
          All
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-6 px-2 text-[11px]"
          onClick={() => setEvents([...MESSAGE_EVENTS])}
        >
          All message events
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-6 px-2 text-[11px]"
          onClick={() => setEvents([...INBOUND_EVENTS])}
        >
          Inbound only
        </Button>
      </div>
      <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
        {ALL_EVENT_TYPES.map((ev) => {
          const id = `event-${ev}`;
          return (
            <label key={ev} htmlFor={id} className="flex cursor-pointer items-center gap-2">
              <Checkbox
                id={id}
                checked={events.includes(ev)}
                onCheckedChange={() => toggleEvent(ev)}
              />
              <span className="font-mono text-xs">{ev}</span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Edit modal
// ---------------------------------------------------------------------------

interface EditModalProps {
  route: WebhookRouteView | null;
  onSaved: (updated: WebhookRouteView) => void;
  onClose: () => void;
}

function EditModal({ route, onSaved, onClose }: EditModalProps) {
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<WebhookEventType[]>([]);
  const [active, setActive] = useState(true);
  const [description, setDescription] = useState('');
  const [urlError, setUrlError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Hydrate from route prop whenever it changes (i.e. dialog opens for a row).
  useEffect(() => {
    if (route) {
      setUrl(route.url);
      setEvents([...route.events]);
      setActive(route.active);
      setDescription(route.description ?? '');
      setUrlError(null);
      setError(null);
      setBusy(false);
    }
  }, [route]);

  function validateUrl(v: string) {
    if (!v.startsWith('https://')) {
      setUrlError('URL must start with https://');
    } else {
      setUrlError(null);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!route) return;
    validateUrl(url);
    if (!url.startsWith('https://')) return;
    if (events.length === 0) {
      setError('Select at least one event type.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/v1/admin/webhooks/${route.routeId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          url,
          events,
          active,
          description: description || null,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = (await res.json()) as { route: WebhookRouteView };
      onSaved(data.route);
      toast.success('Webhook updated');
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={!!route} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit webhook</DialogTitle>
          <DialogDescription>
            Adjust the destination URL, subscribed events, or activation state. Secrets cannot be
            edited here, revoke and recreate to rotate.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="edit-url">URL</Label>
            <Input
              id="edit-url"
              type="url"
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                validateUrl(e.target.value);
              }}
              className={cn('font-mono text-xs', urlError && 'border-destructive')}
              required
            />
            {urlError ? <p className="text-xs text-destructive">{urlError}</p> : null}
          </div>

          <div className="space-y-1.5">
            <Label>Events</Label>
            <EventPicker events={events} setEvents={setEvents} />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="edit-description">Description (optional)</Label>
            <Input
              id="edit-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={256}
            />
          </div>

          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <Checkbox checked={active} onCheckedChange={(checked) => setActive(checked === true)} />
            Active
          </label>

          {error ? (
            <p className="rounded-md border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive">
              {error}
            </p>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !!urlError || events.length === 0}>
              {busy ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Secret-once dialog (shown immediately after create)
// ---------------------------------------------------------------------------

interface SecretDialogProps {
  secret: string | null;
  onClose: () => void;
}

function SecretDialog({ secret, onClose }: SecretDialogProps) {
  const [copied, setCopied] = useState(false);
  const [canDismiss, setCanDismiss] = useState(false);

  // Lock dismiss for 3 s to prevent accidental loss; reset when dialog opens.
  useEffect(() => {
    if (!secret) {
      setCanDismiss(false);
      setCopied(false);
      return;
    }
    setCanDismiss(false);
    setCopied(false);
    const t = setTimeout(() => setCanDismiss(true), 3_000);
    return () => clearTimeout(t);
  }, [secret]);

  async function handleCopy() {
    if (!secret) return;
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      toast.success('Copied');
      setTimeout(() => setCopied(false), 2_500);
    } catch {
      toast.error('Clipboard access denied');
    }
  }

  return (
    <Dialog
      open={!!secret}
      onOpenChange={(open) => {
        if (!open && canDismiss) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-destructive" />
            Webhook secret
          </DialogTitle>
          <DialogDescription>
            This secret signs webhook payloads from the gateway. It will not be shown again, store
            it in your service&apos;s secret manager before dismissing.
          </DialogDescription>
        </DialogHeader>

        {secret ? (
          <pre className="max-h-32 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs leading-relaxed [overflow-wrap:anywhere]">
            {secret}
          </pre>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={handleCopy}>
            {copied ? <Check /> : <Copy />}
            {copied ? 'Copied' : 'Copy secret'}
          </Button>
          <Button
            onClick={onClose}
            disabled={!canDismiss}
            title={canDismiss ? undefined : 'Wait 3 seconds before dismissing'}
          >
            {canDismiss ? 'Done' : 'Dismiss (wait…)'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Create webhook dialog
// ---------------------------------------------------------------------------

interface CreateModalProps {
  open: boolean;
  apiKeys: ApiKeyOption[];
  sessions: SessionOption[];
  onCreated: (route: WebhookRouteView, secret: string) => void;
  onClose: () => void;
}

function CreateModal({ open, apiKeys, sessions, onCreated, onClose }: CreateModalProps) {
  const [scopeKind, setScopeKind] = useState<'apiKey' | 'session'>('apiKey');
  const [apiKeyId, setApiKeyId] = useState(apiKeys[0]?.keyId ?? '');
  const [sessionId, setSessionId] = useState(sessions[0]?.sessionId ?? '');
  const [url, setUrl] = useState('');
  const [urlError, setUrlError] = useState<string | null>(null);
  const [events, setEvents] = useState<WebhookEventType[]>([...MESSAGE_EVENTS]);
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset whenever dialog opens.
  useEffect(() => {
    if (open) {
      setScopeKind('apiKey');
      setApiKeyId(apiKeys[0]?.keyId ?? '');
      setSessionId(sessions[0]?.sessionId ?? '');
      setUrl('');
      setUrlError(null);
      setEvents([...MESSAGE_EVENTS]);
      setDescription('');
      setBusy(false);
      setError(null);
    }
  }, [open, apiKeys, sessions]);

  function validateUrl(v: string) {
    if (!v.startsWith('https://')) {
      setUrlError('URL must start with https://');
    } else {
      setUrlError(null);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    validateUrl(url);
    if (!url.startsWith('https://')) return;
    if (events.length === 0) {
      setError('Select at least one event type.');
      return;
    }

    const scope =
      scopeKind === 'apiKey'
        ? { kind: 'apiKey' as const, apiKeyId }
        : { kind: 'session' as const, sessionId };

    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/v1/admin/webhooks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          scope,
          url,
          events,
          description: description || undefined,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = (await res.json()) as { route: WebhookRouteView; secret: string };
      onCreated(data.route, data.secret);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Create webhook</DialogTitle>
          <DialogDescription>
            Receive delivery and inbound events at your service URL. The signing secret will be
            shown once on creation.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Scope */}
          <div className="space-y-2">
            <Label>Scope</Label>
            <div className="space-y-2 rounded-md border bg-muted/20 p-3">
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="scope-kind"
                  value="apiKey"
                  checked={scopeKind === 'apiKey'}
                  onChange={() => setScopeKind('apiKey')}
                  className="accent-primary"
                />
                API key
              </label>
              {scopeKind === 'apiKey' ? (
                <select
                  value={apiKeyId}
                  onChange={(e) => setApiKeyId(e.target.value)}
                  className="ml-6 flex h-8 w-[calc(100%-1.5rem)] rounded-md border border-input bg-transparent px-2 py-1 text-xs shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  required
                >
                  {apiKeys.length === 0 ? (
                    <option value="" disabled>
                      No API keys
                    </option>
                  ) : (
                    apiKeys.map((k) => (
                      <option key={k.keyId} value={k.keyId}>
                        {k.label} ({k.keyId.slice(0, 10)}…)
                      </option>
                    ))
                  )}
                </select>
              ) : null}

              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="scope-kind"
                  value="session"
                  checked={scopeKind === 'session'}
                  onChange={() => setScopeKind('session')}
                  className="accent-primary"
                />
                Session
              </label>
              {scopeKind === 'session' ? (
                <select
                  value={sessionId}
                  onChange={(e) => setSessionId(e.target.value)}
                  className="ml-6 flex h-8 w-[calc(100%-1.5rem)] rounded-md border border-input bg-transparent px-2 py-1 text-xs shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  required
                >
                  {sessions.length === 0 ? (
                    <option value="" disabled>
                      No sessions
                    </option>
                  ) : (
                    sessions.map((s) => (
                      <option key={s.sessionId} value={s.sessionId}>
                        {s.label} ({s.sessionId})
                      </option>
                    ))
                  )}
                </select>
              ) : null}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="create-url">URL</Label>
            <Input
              id="create-url"
              type="url"
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                validateUrl(e.target.value);
              }}
              placeholder="https://your-service.example.com/webhooks/hmd"
              className={cn('font-mono text-xs', urlError && 'border-destructive')}
              required
              autoFocus
            />
            {urlError ? <p className="text-xs text-destructive">{urlError}</p> : null}
          </div>

          <div className="space-y-1.5">
            <Label>Events</Label>
            <EventPicker events={events} setEvents={setEvents} />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="create-description">Description (optional)</Label>
            <Input
              id="create-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={256}
              placeholder="e.g. session-a production endpoint"
            />
          </div>

          {error ? (
            <p className="rounded-md border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive">
              {error}
            </p>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={
                busy ||
                !!urlError ||
                events.length === 0 ||
                (scopeKind === 'apiKey' && !apiKeyId) ||
                (scopeKind === 'session' && !sessionId)
              }
            >
              {busy ? 'Creating…' : 'Create webhook'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Test result inline indicator
// ---------------------------------------------------------------------------

interface TestResult {
  ok: boolean;
  httpStatus: number | null;
  durationMs: number;
  error?: string;
}

function TestResultInline({ result }: { result: TestResult }) {
  const Icon = result.ok ? CircleCheck : CircleX;
  const colour = result.ok ? 'text-emerald-500' : 'text-destructive';
  const label = result.ok
    ? `${result.httpStatus ?? '?'} OK in ${result.durationMs}ms`
    : `Failed: ${result.httpStatus ?? result.error ?? 'timeout'}`;
  return (
    <span className={cn('inline-flex items-center gap-1 font-mono text-xs', colour)}>
      <Icon className="h-3 w-3" />
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Webhook row (table row)
// ---------------------------------------------------------------------------

interface WebhookRowProps {
  route: WebhookRouteView;
  apiKeys: ApiKeyOption[];
  sessions: SessionOption[];
  stepUpDone: boolean;
  onStepUpRequired: () => void;
  onRevoked: (routeId: string) => void;
  onEdit: (route: WebhookRouteView) => void;
}

function WebhookRow({
  route,
  apiKeys,
  sessions,
  stepUpDone,
  onStepUpRequired,
  onRevoked,
  onEdit,
}: WebhookRowProps) {
  const [showRevoke, setShowRevoke] = useState(false);
  const [revokeBusy, setRevokeBusy] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [testBusy, setTestBusy] = useState(false);
  const clearTestRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function scheduleTestClear() {
    if (clearTestRef.current) clearTimeout(clearTestRef.current);
    clearTestRef.current = setTimeout(() => setTestResult(null), 8_000);
  }

  async function handleTest() {
    if (!stepUpDone) {
      onStepUpRequired();
      return;
    }
    setTestBusy(true);
    try {
      const res = await fetch(`/v1/admin/webhooks/${route.routeId}/test`, {
        method: 'POST',
      });
      if (!res.ok) throw new Error(await res.text());
      const data = (await res.json()) as TestResult;
      setTestResult(data);
      scheduleTestClear();
    } catch (err) {
      setTestResult({
        ok: false,
        httpStatus: null,
        durationMs: 0,
        error: (err as Error).message,
      });
      scheduleTestClear();
    } finally {
      setTestBusy(false);
    }
  }

  async function handleRevoke() {
    setRevokeBusy(true);
    try {
      const res = await fetch(`/v1/admin/webhooks/${route.routeId}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error(await res.text());
      onRevoked(route.routeId);
      toast.success('Webhook revoked');
    } catch (err) {
      toast.error(`Revoke failed: ${(err as Error).message}`);
    } finally {
      setRevokeBusy(false);
      setShowRevoke(false);
    }
  }

  function lastDeliveryCell() {
    if (route.lastDeliveryStatus === 'sent') {
      return (
        <Badge variant="outline" className="border-emerald-500/30 text-emerald-500">
          <CircleCheck className="mr-1 h-3 w-3" />
          {route.lastDeliveryHttpStatus ?? 'sent'}
          <span className="ml-1.5 text-muted-foreground">{timeAgo(route.lastDeliveryAt)}</span>
        </Badge>
      );
    }
    if (route.lastDeliveryStatus === 'failed') {
      return (
        <Badge variant="outline" className="border-destructive/40 text-destructive">
          <CircleX className="mr-1 h-3 w-3" />
          {route.lastDeliveryHttpStatus ?? 'failed'}
          <span className="ml-1.5 text-muted-foreground">{timeAgo(route.lastDeliveryAt)}</span>
        </Badge>
      );
    }
    return (
      <Badge variant="outline" className="text-muted-foreground">
        <CircleDashed className="mr-1 h-3 w-3" />
        none
      </Badge>
    );
  }

  return (
    <>
      <TableRow className={cn(route.revokedAt && 'opacity-60')}>
        <TableCell className="align-top">
          <div className="space-y-1">
            <code className="block max-w-[28rem] truncate font-mono text-xs" title={route.url}>
              {truncateUrl(route.url)}
            </code>
            <div className="text-[11px] text-muted-foreground">
              {scopeLabel(route.scope, apiKeys, sessions)}
            </div>
            <div
              className="font-mono text-[10px] text-muted-foreground"
              title="Secret fingerprint, not the secret itself"
            >
              fp:{route.secretFingerprint}
            </div>
            {route.description ? (
              <div className="max-w-[28rem] truncate text-[11px] italic text-muted-foreground">
                {route.description}
              </div>
            ) : null}
          </div>
        </TableCell>
        <TableCell className="align-top">
          <div className="flex flex-wrap gap-1">
            {route.events.map((ev) => (
              <EventChip key={ev} event={ev} />
            ))}
          </div>
        </TableCell>
        <TableCell className="align-top">
          {route.revokedAt ? (
            <Badge variant="outline" className="text-destructive">
              Revoked
            </Badge>
          ) : route.active ? (
            <Badge variant="outline" className="border-emerald-500/30 text-emerald-500">
              Active
            </Badge>
          ) : (
            <Badge variant="outline" className="text-muted-foreground">
              Inactive
            </Badge>
          )}
        </TableCell>
        <TableCell className="align-top tabular-nums">{lastDeliveryCell()}</TableCell>
        <TableCell className="align-top">
          {route.revokedAt ? (
            <p className="text-xs text-muted-foreground">Revoked {timeAgo(route.revokedAt)}</p>
          ) : (
            <div className="flex flex-wrap items-center gap-1.5">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={handleTest}
                disabled={testBusy || !route.active}
                title={route.active ? 'Send a test event to this URL' : 'Route is inactive'}
              >
                <Send />
                {testBusy ? 'Testing…' : 'Test'}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  if (!stepUpDone) {
                    onStepUpRequired();
                    return;
                  }
                  onEdit(route);
                }}
              >
                <Pencil />
                Edit
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={() => {
                  if (!stepUpDone) {
                    onStepUpRequired();
                    return;
                  }
                  setShowRevoke(true);
                }}
              >
                <Trash2 />
                Revoke
              </Button>
              {testResult ? <TestResultInline result={testResult} /> : null}
            </div>
          )}
        </TableCell>
      </TableRow>

      <AlertDialog open={showRevoke} onOpenChange={setShowRevoke}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke webhook?</AlertDialogTitle>
            <AlertDialogDescription>
              Future events will not be delivered to this URL. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <pre className="overflow-auto rounded-md border bg-muted/40 p-2 font-mono text-xs [overflow-wrap:anywhere]">
            {route.url}
          </pre>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revokeBusy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void handleRevoke();
              }}
              disabled={revokeBusy}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {revokeBusy ? 'Revoking…' : 'Revoke'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------

type FilterTab = 'apiKey' | 'session';

export function WebhooksPanel({
  initialRoutes,
  apiKeys,
  sessions,
  stepUpDone,
  onStepUpRequired,
}: WebhooksPanelProps) {
  const [routes, setRoutes] = useState<WebhookRouteView[]>(initialRoutes);
  const [filterTab, setFilterTab] = useState<FilterTab>('apiKey');
  const [selectedApiKeyId, setSelectedApiKeyId] = useState(apiKeys[0]?.keyId ?? '');
  const [selectedSessionId, setSelectedSessionId] = useState(sessions[0]?.sessionId ?? '');
  const [showCreate, setShowCreate] = useState(false);
  const [editTarget, setEditTarget] = useState<WebhookRouteView | null>(null);
  const [pendingSecret, setPendingSecret] = useState<string | null>(null);

  const refreshRoutes = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (filterTab === 'apiKey' && selectedApiKeyId) {
        params.set('apiKeyId', selectedApiKeyId);
      } else if (filterTab === 'session' && selectedSessionId) {
        params.set('sessionId', selectedSessionId);
      }
      const res = await fetch(`/v1/admin/webhooks?${params.toString()}`, { cache: 'no-store' });
      if (res.ok) {
        const data = (await res.json()) as { routes: WebhookRouteView[] };
        setRoutes(data.routes);
      }
    } catch {
      /* ignore transient errors */
    }
  }, [filterTab, selectedApiKeyId, selectedSessionId]);

  // Re-fetch whenever the filter changes.
  useEffect(() => {
    void refreshRoutes();
  }, [refreshRoutes]);

  function handleCreated(route: WebhookRouteView, secret: string) {
    setRoutes((prev) => [route, ...prev]);
    setShowCreate(false);
    setPendingSecret(secret);
    toast.success('Webhook created');
  }

  function handleRevoked(routeId: string) {
    setRoutes((prev) =>
      prev.map((r) =>
        r.routeId === routeId ? { ...r, revokedAt: new Date().toISOString(), active: false } : r,
      ),
    );
  }

  function handleUpdated(updated: WebhookRouteView) {
    setRoutes((prev) => prev.map((r) => (r.routeId === updated.routeId ? updated : r)));
  }

  const filteredRoutes = routes.filter((r) => {
    if (filterTab === 'apiKey') {
      return (
        r.scope.kind === 'apiKey' && (!selectedApiKeyId || r.scope.apiKeyId === selectedApiKeyId)
      );
    }
    return (
      r.scope.kind === 'session' && (!selectedSessionId || r.scope.sessionId === selectedSessionId)
    );
  });

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold tracking-tight">Webhooks</h2>
          <p className="text-xs text-muted-foreground">
            Outbound delivery and inbound event subscriptions, scoped to an API key or session.
          </p>
        </div>
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
          Create webhook
        </Button>
      </div>

      <Card>
        <CardHeader className="gap-3 pb-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <Tabs value={filterTab} onValueChange={(v) => setFilterTab(v as FilterTab)}>
              <TabsList>
                <TabsTrigger value="apiKey">By API key</TabsTrigger>
                <TabsTrigger value="session">By session</TabsTrigger>
              </TabsList>
            </Tabs>

            {filterTab === 'apiKey' ? (
              <select
                value={selectedApiKeyId}
                onChange={(e) => setSelectedApiKeyId(e.target.value)}
                className="flex h-8 rounded-md border border-input bg-transparent px-2 py-1 text-xs shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                {apiKeys.length === 0 ? (
                  <option value="">No API keys</option>
                ) : (
                  apiKeys.map((k) => (
                    <option key={k.keyId} value={k.keyId}>
                      {k.label}
                    </option>
                  ))
                )}
              </select>
            ) : (
              <select
                value={selectedSessionId}
                onChange={(e) => setSelectedSessionId(e.target.value)}
                className="flex h-8 rounded-md border border-input bg-transparent px-2 py-1 text-xs shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                {sessions.length === 0 ? (
                  <option value="">No sessions</option>
                ) : (
                  sessions.map((s) => (
                    <option key={s.sessionId} value={s.sessionId}>
                      {s.label} ({s.sessionId})
                    </option>
                  ))
                )}
              </select>
            )}
          </div>
          <CardDescription>
            {filteredRoutes.length} route{filteredRoutes.length === 1 ? '' : 's'} for the selected
            filter.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          {filteredRoutes.length === 0 ? (
            <p className="px-6 py-8 text-center text-sm text-muted-foreground">
              No webhooks configured. Create one to receive delivery and inbound events at your
              service URL.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Endpoint</TableHead>
                  <TableHead>Events</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>Last delivery</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredRoutes.map((route) => (
                  <WebhookRow
                    key={route.routeId}
                    route={route}
                    apiKeys={apiKeys}
                    sessions={sessions}
                    stepUpDone={stepUpDone}
                    onStepUpRequired={onStepUpRequired}
                    onRevoked={handleRevoked}
                    onEdit={setEditTarget}
                  />
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <CreateModal
        open={showCreate}
        apiKeys={apiKeys}
        sessions={sessions}
        onCreated={handleCreated}
        onClose={() => setShowCreate(false)}
      />

      <EditModal route={editTarget} onSaved={handleUpdated} onClose={() => setEditTarget(null)} />

      <SecretDialog secret={pendingSecret} onClose={() => setPendingSecret(null)} />
    </section>
  );
}

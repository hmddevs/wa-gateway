'use client';
import { useCallback, useEffect, useState } from 'react';
import { KeyRound, Copy, Check, RotateCcw, Pencil, Trash2 } from 'lucide-react';
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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
import {
  ALL_SCOPES,
  PROJECT_ID_RE,
  type ApiKeyView,
  type CreatedKey,
  type Scope,
  type SessionSnapshot,
  timeAgo,
} from '../_types';

interface ApiKeysPanelProps {
  sessions: SessionSnapshot[];
  stepUpDone: boolean;
  onStepUpRequired: () => void;
}

// ---------------------------------------------------------------------------
// SecretDialog
// ---------------------------------------------------------------------------

interface SecretDialogProps {
  created: CreatedKey | null;
  variant?: 'created' | 'rotated';
  onClose: () => void;
}

function SecretDialog({ created, variant = 'created', onClose }: SecretDialogProps) {
  const [copied, setCopied] = useState(false);

  // Reset copy state when the plaintext changes; keyId is stable across rotations.
  useEffect(() => {
    setCopied(false);
  }, [created?.plaintext]);

  async function handleCopy() {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.plaintext);
      setCopied(true);
      toast.success('Copied');
      setTimeout(() => setCopied(false), 2_500);
    } catch {
      toast.error('Clipboard access denied');
    }
  }

  const title = variant === 'rotated' ? 'Secret rotated' : 'API key created';
  const description =
    variant === 'rotated'
      ? 'The previous secret has been revoked. Update all consumers before dismissing this dialog.'
      : "Copy the secret now. It will not be shown again, store it in your service's secret manager before dismissing this dialog.";

  return (
    <Dialog open={!!created} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {created ? (
          <div className="space-y-3">
            <pre className="max-h-32 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs leading-relaxed [overflow-wrap:anywhere]">
              {created.plaintext}
            </pre>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <dt>Key ID</dt>
              <dd className="font-mono text-foreground">{created.keyId}</dd>
              <dt>Project</dt>
              <dd className="font-mono text-foreground">{created.projectId}</dd>
              <dt>Session</dt>
              <dd className="font-mono text-foreground">{created.sessionId}</dd>
              <dt>Environment</dt>
              <dd className="text-foreground">{created.env}</dd>
              <dt>Scopes</dt>
              <dd className="text-foreground">{created.scopes.join(', ')}</dd>
            </dl>
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={handleCopy}>
            {copied ? <Check /> : <Copy />}
            {copied ? 'Copied' : 'Copy secret'}
          </Button>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// EditDialog
// ---------------------------------------------------------------------------

const CIDR_RE = /^(\d{1,3}\.){3}\d{1,3}(\/(\d|[12]\d|3[0-2]))?$/;

interface EditDialogProps {
  apiKey: ApiKeyView | null;
  onClose: () => void;
  onSaved: () => void;
}

function EditDialog({ apiKey, onClose, onSaved }: EditDialogProps) {
  const [rateLimit, setRateLimit] = useState(60);
  const [cidrs, setCidrs] = useState<string[]>([]);
  const [cidrInput, setCidrInput] = useState('');
  const [cidrError, setCidrError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Sync form state whenever the target key changes. Dep on keyId only, // we want to reset when the user opens a different key, not on every poll
  // refresh of the same key.
  useEffect(() => {
    if (!apiKey) return;
    setRateLimit(apiKey.rateLimitPerMin);
    setCidrs(apiKey.ipAllowlist ?? []);
    setCidrInput('');
    setCidrError(null);
    setSaveError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey?.keyId]);

  function addCidr() {
    const val = cidrInput.trim();
    if (!CIDR_RE.test(val)) {
      setCidrError('Invalid IP or CIDR block');
      return;
    }
    if (cidrs.includes(val)) {
      setCidrError('Already in list');
      return;
    }
    setCidrs((prev) => [...prev, val]);
    setCidrInput('');
    setCidrError(null);
  }

  async function handleSave() {
    if (!apiKey) return;
    setBusy(true);
    setSaveError(null);
    try {
      const res = await fetch(`/api/admin/keys/${apiKey.keyId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          rateLimitPerMin: rateLimit,
          ipAllowlist: cidrs,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      onSaved();
      onClose();
    } catch (err) {
      setSaveError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={!!apiKey} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit key, {apiKey?.label}</DialogTitle>
          <DialogDescription>
            Adjust rate limit and IP allowlist. Changes take effect immediately.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[70vh] space-y-5 overflow-y-auto pr-1">
          {/* Rate limit */}
          <div className="space-y-1.5">
            <Label htmlFor="edit-rate">Rate limit (req/min)</Label>
            <Input
              id="edit-rate"
              type="number"
              min={1}
              max={10000}
              value={rateLimit}
              onChange={(e) => setRateLimit(Number(e.target.value))}
              className="tabular-nums"
            />
          </div>

          {/* IP allowlist */}
          <div className="space-y-1.5">
            <Label>IP allowlist</Label>
            <p className="text-xs text-muted-foreground">
              Leave empty to allow all IPs. Entries are IPv4 addresses or CIDR blocks.
            </p>

            {cidrs.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {cidrs.map((cidr) => (
                  <span
                    key={cidr}
                    className="inline-flex items-center gap-1 rounded border bg-muted/40 px-2 py-0.5 font-mono text-xs"
                  >
                    {cidr}
                    <button
                      type="button"
                      onClick={() => setCidrs((prev) => prev.filter((c) => c !== cidr))}
                      className="ml-0.5 rounded-sm opacity-60 hover:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      aria-label={`Remove ${cidr}`}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground/60">No restrictions</p>
            )}

            <div className="flex gap-2">
              <Input
                value={cidrInput}
                onChange={(e) => {
                  setCidrInput(e.target.value);
                  setCidrError(null);
                }}
                onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addCidr())}
                placeholder="192.168.1.0/24"
                className="font-mono text-xs"
              />
              <Button type="button" variant="outline" size="sm" onClick={addCidr}>
                Add
              </Button>
            </div>
            {cidrError ? <p className="text-xs text-destructive">{cidrError}</p> : null}
          </div>

          {saveError ? (
            <p className="rounded-md border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive">
              {saveError}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={busy}>
            {busy ? 'Saving…' : 'Save changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// KeysTable
// ---------------------------------------------------------------------------

interface KeysTableProps {
  keys: ApiKeyView[];
  stepUpDone: boolean;
  onStepUpRequired: () => void;
  onRotated: (key: CreatedKey) => void;
  onRevoked: () => void;
  onEdit: (key: ApiKeyView) => void;
}

function KeysTable({
  keys,
  stepUpDone,
  onStepUpRequired,
  onRotated,
  onRevoked,
  onEdit,
}: KeysTableProps) {
  const [revokeTarget, setRevokeTarget] = useState<ApiKeyView | null>(null);
  const [rotatingId, setRotatingId] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  async function handleRotate(key: ApiKeyView) {
    if (!stepUpDone) {
      onStepUpRequired();
      return;
    }
    setRotatingId(key.keyId);
    try {
      const res = await fetch(`/api/admin/keys/${key.keyId}/rotate`, { method: 'POST' });
      if (!res.ok) throw new Error(await res.text());
      const data = (await res.json()) as CreatedKey;
      onRotated(data);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setRotatingId(null);
    }
  }

  async function handleRevoke() {
    if (!revokeTarget) return;
    if (!stepUpDone) {
      setRevokeTarget(null);
      onStepUpRequired();
      return;
    }
    setRevokingId(revokeTarget.keyId);
    try {
      const res = await fetch(`/api/admin/keys/${revokeTarget.keyId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(await res.text());
      onRevoked();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setRevokingId(null);
      setRevokeTarget(null);
    }
  }

  // Active keys first (newest createdAt desc), revoked at the bottom.
  const sorted = [...keys].sort((a, b) => {
    const aRevoked = !!a.revokedAt;
    const bRevoked = !!b.revokedAt;
    if (aRevoked !== bRevoked) return aRevoked ? 1 : -1;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });

  if (sorted.length === 0) {
    return (
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Label</TableHead>
              <TableHead>Division / Project</TableHead>
              <TableHead>Env</TableHead>
              <TableHead>Session</TableHead>
              <TableHead>Scopes</TableHead>
              <TableHead>Rate</TableHead>
              <TableHead>Last used</TableHead>
              <TableHead>Status</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell colSpan={9} className="text-center text-xs text-muted-foreground">
                No keys yet
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>
    );
  }

  return (
    <>
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Label</TableHead>
              <TableHead>Division / Project</TableHead>
              <TableHead>Env</TableHead>
              <TableHead>Session</TableHead>
              <TableHead>Scopes</TableHead>
              <TableHead>Rate</TableHead>
              <TableHead>Last used</TableHead>
              <TableHead>Status</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((key) => {
              const revoked = !!key.revokedAt;
              return (
                <TableRow key={key.keyId} className={cn(revoked && 'opacity-50')}>
                  <TableCell className="text-xs font-medium">
                    <span className={cn(revoked && 'line-through')}>{key.label}</span>
                  </TableCell>
                  <TableCell className="text-xs">
                    <span className="text-foreground">{key.division}</span>
                    <span className="block font-mono text-[10px] text-muted-foreground">
                      {key.projectId}
                    </span>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant="outline"
                      className={cn(
                        'text-xs',
                        key.env === 'live'
                          ? 'border-emerald-500/50 text-emerald-600 dark:text-emerald-400'
                          : 'border-amber-500/50 text-amber-600 dark:text-amber-400',
                      )}
                    >
                      {key.env}
                    </Badge>
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {key.sessionId}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {key.scopes.map((s) => (
                        <span
                          key={s}
                          className="rounded border bg-muted/40 px-1.5 py-0.5 font-mono text-xs text-muted-foreground"
                        >
                          {s}
                        </span>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell className="tabular-nums text-xs">{key.rateLimitPerMin}/min</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {timeAgo(key.lastUsedAt)}
                  </TableCell>
                  <TableCell>
                    {revoked ? (
                      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                        <span className="h-1.5 w-1.5 rounded-full bg-destructive" />
                        Revoked
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                        Active
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    {!revoked ? (
                      <div className="flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          title="Rotate secret"
                          disabled={rotatingId === key.keyId}
                          onClick={() => handleRotate(key)}
                        >
                          <RotateCcw className="h-3.5 w-3.5" />
                          <span className="sr-only">Rotate</span>
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          title="Edit"
                          onClick={() => onEdit(key)}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                          <span className="sr-only">Edit</span>
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-destructive hover:text-destructive"
                          title="Revoke"
                          disabled={revokingId === key.keyId}
                          onClick={() => {
                            if (!stepUpDone) {
                              onStepUpRequired();
                              return;
                            }
                            setRevokeTarget(key);
                          }}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          <span className="sr-only">Revoke</span>
                        </Button>
                      </div>
                    ) : null}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      <AlertDialog open={!!revokeTarget} onOpenChange={(open) => !open && setRevokeTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke key?</AlertDialogTitle>
            <AlertDialogDescription>
              &quot;{revokeTarget?.label}&quot; will stop authenticating immediately. This cannot be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleRevoke}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Revoke
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// ---------------------------------------------------------------------------
// ApiKeysPanel
// ---------------------------------------------------------------------------

export function ApiKeysPanel({ sessions, stepUpDone, onStepUpRequired }: ApiKeysPanelProps) {
  const activeSessions = sessions.filter((s) => s.status !== 'stopped');

  // Keys list state.
  const [keys, setKeys] = useState<ApiKeyView[]>([]);
  const [loadingKeys, setLoadingKeys] = useState(true);

  // Dialogs.
  const [createdKey, setCreatedKey] = useState<CreatedKey | null>(null);
  const [secretVariant, setSecretVariant] = useState<'created' | 'rotated'>('created');
  const [editingKey, setEditingKey] = useState<ApiKeyView | null>(null);

  // Create-form state.
  const [label, setLabel] = useState('');
  const [division, setDivision] = useState('');
  const [projectId, setProjectId] = useState('');
  const [projectIdError, setProjectIdError] = useState<string | null>(null);
  const [env, setEnv] = useState<'test' | 'live'>('test');
  const [scopes, setScopes] = useState<Scope[]>(['send:notification']);
  const [rateLimitPerMin, setRateLimitPerMin] = useState(60);
  const [sessionId, setSessionId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Default the session selection to the first active session.
  useEffect(() => {
    const first = activeSessions[0];
    if (first && !sessionId) {
      setSessionId(first.sessionId);
    }
  }, [activeSessions, sessionId]);

  const fetchKeys = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/keys');
      if (!res.ok) throw new Error(await res.text());
      const data = (await res.json()) as { keys: ApiKeyView[] };
      setKeys(data.keys);
    } catch (err) {
      toast.error(`Failed to load keys: ${(err as Error).message}`);
    } finally {
      setLoadingKeys(false);
    }
  }, []);

  useEffect(() => {
    void fetchKeys();
  }, [fetchKeys]);

  function toggleScope(scope: Scope) {
    setScopes((prev) =>
      prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope],
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!stepUpDone) {
      onStepUpRequired();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          label,
          division,
          projectId,
          env,
          scopes,
          rateLimitPerMin,
          sessionId,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = (await res.json()) as CreatedKey;
      setSecretVariant('created');
      setCreatedKey(data);
      // Reset form fields except sessionId.
      setLabel('');
      setDivision('');
      setProjectId('');
      setProjectIdError(null);
      setScopes(['send:notification']);
      setRateLimitPerMin(60);
      void fetchKeys();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-base font-semibold tracking-tight">API keys</h2>
        <p className="text-xs text-muted-foreground">
          Manage keys for downstream services. Secrets are shown once on creation or rotation.
        </p>
      </div>

      {/* Section 1, Keys table */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <KeyRound className="h-4 w-4 text-primary" />
            Issued keys
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0 pb-2">
          {loadingKeys ? (
            <p className="px-6 py-4 text-xs text-muted-foreground">Loading…</p>
          ) : (
            <KeysTable
              keys={keys}
              stepUpDone={stepUpDone}
              onStepUpRequired={onStepUpRequired}
              onRotated={(key) => {
                setSecretVariant('rotated');
                setCreatedKey(key);
                void fetchKeys();
              }}
              onRevoked={() => void fetchKeys()}
              onEdit={(key) => setEditingKey(key)}
            />
          )}
        </CardContent>
      </Card>

      {/* Section 2, Create form */}
      <Card>
        <CardHeader className="pb-4">
          <CardTitle className="flex items-center gap-2 text-sm">
            <KeyRound className="h-4 w-4 text-primary" />
            Create API key
          </CardTitle>
          <CardDescription>
            Scoped to a single session. Live keys carry production privileges; default to test.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-5">
            {/* Project ID, identity field, appears before all policy fields */}
            <div className="space-y-1.5">
              <Label htmlFor="key-project-id">Project ID</Label>
              <Input
                id="key-project-id"
                value={projectId}
                onChange={(e) => {
                  const val = e.target.value;
                  setProjectId(val);
                  if (val && !PROJECT_ID_RE.test(val)) {
                    setProjectIdError('Lowercase kebab slug, 1–64 chars (e.g. example-service)');
                  } else {
                    setProjectIdError(null);
                  }
                }}
                placeholder="acme, org-a, example-service"
                required
                aria-describedby={projectIdError ? 'key-project-id-error' : 'key-project-id-hint'}
                aria-invalid={projectIdError ? true : undefined}
                className="font-mono text-sm"
              />
              {projectIdError ? (
                <p id="key-project-id-error" role="alert" className="text-xs text-destructive">
                  {projectIdError}
                </p>
              ) : (
                <p id="key-project-id-hint" className="text-xs text-muted-foreground">
                  Lowercase kebab slug, 1–64 chars. Stamps every message sent with this key for
                  audit, billing, and routing. Cannot be changed after issuance.
                </p>
              )}
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="key-label">Label</Label>
                <Input
                  id="key-label"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="e.g. session-a production"
                  required
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="key-division">Division</Label>
                <Input
                  id="key-division"
                  value={division}
                  onChange={(e) => setDivision(e.target.value)}
                  placeholder="e.g. session-a"
                  required
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="key-env">Environment</Label>
                <select
                  id="key-env"
                  value={env}
                  onChange={(e) => setEnv(e.target.value as 'test' | 'live')}
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  <option value="test">test</option>
                  <option value="live">live</option>
                </select>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="key-session">Session</Label>
                <select
                  id="key-session"
                  value={sessionId}
                  onChange={(e) => setSessionId(e.target.value)}
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  required
                >
                  {activeSessions.length === 0 ? (
                    <option value="" disabled>
                      No active sessions
                    </option>
                  ) : (
                    activeSessions.map((s) => (
                      <option key={s.sessionId} value={s.sessionId}>
                        {s.label} ({s.sessionId})
                      </option>
                    ))
                  )}
                </select>
              </div>

              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="key-rate">Rate limit (req/min)</Label>
                <Input
                  id="key-rate"
                  type="number"
                  min={1}
                  max={10000}
                  value={rateLimitPerMin}
                  onChange={(e) => setRateLimitPerMin(Number(e.target.value))}
                  className="tabular-nums"
                  required
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label>Scopes</Label>
              <div className="grid grid-cols-1 gap-2 rounded-md border bg-muted/20 p-3 sm:grid-cols-2">
                {ALL_SCOPES.map((scope) => {
                  const checkboxId = `scope-${scope}`;
                  return (
                    <label
                      key={scope}
                      htmlFor={checkboxId}
                      className="flex cursor-pointer items-center gap-2 text-sm"
                    >
                      <Checkbox
                        id={checkboxId}
                        checked={scopes.includes(scope)}
                        onCheckedChange={() => toggleScope(scope)}
                      />
                      <span className="font-mono text-xs">{scope}</span>
                    </label>
                  );
                })}
              </div>
            </div>

            {error ? (
              <p className="rounded-md border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive">
                {error}
              </p>
            ) : null}

            <Button
              type="submit"
              disabled={
                busy ||
                scopes.length === 0 ||
                activeSessions.length === 0 ||
                !projectId ||
                !PROJECT_ID_RE.test(projectId)
              }
            >
              <KeyRound />
              {busy ? 'Creating…' : 'Create API key'}
            </Button>
          </form>
        </CardContent>
      </Card>

      <SecretDialog
        created={createdKey}
        variant={secretVariant}
        onClose={() => setCreatedKey(null)}
      />
      <EditDialog
        apiKey={editingKey}
        onClose={() => setEditingKey(null)}
        onSaved={() => void fetchKeys()}
      />
    </section>
  );
}

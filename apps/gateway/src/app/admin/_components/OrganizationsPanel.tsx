// Developed by HMD Developments
// For HMD WA Gateway
// www.hmddevs.org
'use client';
/**
 * Organizations panel, the unit an API key binds to. An organization owns a
 * set of member WhatsApp numbers (sessions); the router picks which one sends
 * (see docs/ORGANIZATIONS.md). Attaching or detaching a number is an admin
 * operation here, no key change and no deploy.
 *
 * Mirrors conventions established elsewhere in this admin dashboard:
 *  - dialog-driven creation, WebAuthn step-up gating on every mutation the API
 *    actually requires it for (org create, org add/remove, pairing-link create)
 *  - one-time-reveal link dialog with copy-to-clipboard and table/status-badge
 *    styling shared with `ApiKeysPanel`
 *
 * "Attached" is read from each organization's own `sessions` array, which is
 * also what the router walks. `addSession`/`removeSession` keep each session's
 * `orgId` in step with it, so the two never disagree.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Building2,
  Plus,
  Link2,
  Copy,
  Check,
  Ban,
  Loader2,
  Pause,
  Play,
  Unlink,
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
  ORG_ID_RE,
  PAIRING_STATUS_DOT,
  PAIRING_STATUS_LABEL,
  STATUS_DOT,
  STATUS_LABEL,
  type CreatedPairingInvite,
  type OrganizationView,
  type PairingInviteView,
  type OrgStrategy,
  type SessionSnapshot,
  fmtDate,
} from '../_types';

interface OrganizationsPanelProps {
  sessions: SessionSnapshot[];
  stepUpDone: boolean;
  onStepUpRequired: () => void;
  /** Same callback `SessionsPanel` uses, forces the parent's session poll so
   *  a pause/resume shows up immediately instead of waiting out the 6s cycle. */
  onSessionsMutated: () => Promise<void> | void;
}

function fmtBudget(budget: SessionSnapshot['budget']): string {
  if (!budget) return ', ';
  return `${budget.perMinute}/min · ${budget.perHour}/hr · ${budget.perDay}/day`;
}

// ---------------------------------------------------------------------------
// CreateOrgDialog
// ---------------------------------------------------------------------------

interface CreateOrgDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  stepUpDone: boolean;
  onCreated: () => void;
}

function CreateOrgDialog({ open, onOpenChange, stepUpDone, onCreated }: CreateOrgDialogProps) {
  const [orgId, setOrgId] = useState('');
  const [idError, setIdError] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [strategy, setStrategy] = useState<OrgStrategy>('weighted');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setOrgId('');
      setIdError(null);
      setLabel('');
      setStrategy('weighted');
      setError(null);
      setBusy(false);
    }
  }, [open]);

  function validateId(value: string) {
    setIdError(ORG_ID_RE.test(value) ? null : '2 to 32 lowercase letters, digits, or hyphens');
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!stepUpDone) return;
    if (!ORG_ID_RE.test(orgId)) {
      validateId(orgId);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/organizations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ orgId, label, strategy }),
      });
      if (!res.ok) throw new Error(await res.text());
      toast.success(`Organization ${orgId} created`);
      onCreated();
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
          <DialogTitle>Create organization</DialogTitle>
          <DialogDescription>
            An API key binds to this organization, not to any one number. Attach numbers to it after
            creation.
          </DialogDescription>
        </DialogHeader>

        {!stepUpDone ? (
          <p className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
            Step-up verification required. Use the Security panel to re-verify, then try again.
          </p>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="org-id">Organization ID</Label>
              <Input
                id="org-id"
                value={orgId}
                onChange={(e) => {
                  setOrgId(e.target.value);
                  validateId(e.target.value);
                }}
                placeholder="e.g. org-a"
                className="font-mono"
                required
                autoFocus
              />
              {idError ? <p className="text-xs text-destructive">{idError}</p> : null}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="org-label">Label</Label>
              <Input
                id="org-label"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="e.g. Acme Co"
                required
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="org-strategy">Routing strategy</Label>
              <select
                id="org-strategy"
                value={strategy}
                onChange={(e) => setStrategy(e.target.value as OrgStrategy)}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <option value="weighted">Weighted (spread by remaining budget)</option>
                <option value="priority">Priority (first eligible in list order)</option>
                <option value="round-robin">Round-robin (even rotation)</option>
              </select>
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
                {busy ? 'Creating…' : 'Create organization'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// CreatePairingLinkDialog + LinkRevealDialog
// ---------------------------------------------------------------------------

interface CreatePairingLinkDialogProps {
  orgId: string | null;
  stepUpDone: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (invite: CreatedPairingInvite) => void;
}

function CreatePairingLinkDialog({
  orgId,
  stepUpDone,
  onOpenChange,
  onCreated,
}: CreatePairingLinkDialogProps) {
  const [label, setLabel] = useState('');
  const [maxSessions, setMaxSessions] = useState(5);
  const [ttlHours, setTtlHours] = useState(168);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!orgId) {
      setLabel('');
      setMaxSessions(5);
      setTtlHours(168);
      setError(null);
      setBusy(false);
    }
  }, [orgId]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!orgId || !stepUpDone) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/pairing-invites', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          orgId,
          maxSessions,
          ttlHours,
          ...(label ? { label } : {}),
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = (await res.json()) as CreatedPairingInvite;
      onCreated(data);
      onOpenChange(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={!!orgId} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create pairing link</DialogTitle>
          <DialogDescription>
            One link the client can reopen to add several numbers themselves, each one is
            provisioned and attached to &ldquo;{orgId}&rdquo; the moment they scan.
          </DialogDescription>
        </DialogHeader>

        {!stepUpDone ? (
          <p className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
            Step-up verification required. Use the Security panel to re-verify, then try again.
          </p>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="link-label">Label</Label>
              <Input
                id="link-label"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="e.g. Client name (optional)"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="link-max-sessions">Max numbers</Label>
                <Input
                  id="link-max-sessions"
                  type="number"
                  min={1}
                  max={20}
                  value={maxSessions}
                  onChange={(e) => setMaxSessions(Number(e.target.value))}
                  className="tabular-nums"
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="link-ttl">Expires in (hours)</Label>
                <Input
                  id="link-ttl"
                  type="number"
                  min={1}
                  max={720}
                  value={ttlHours}
                  onChange={(e) => setTtlHours(Number(e.target.value))}
                  className="tabular-nums"
                  required
                />
              </div>
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
              <Button type="submit" disabled={busy}>
                {busy ? 'Generating…' : 'Generate link'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function LinkRevealDialog({
  created,
  onClose,
}: {
  created: CreatedPairingInvite | null;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setCopied(false);
  }, [created?.url]);

  async function handleCopy() {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.url);
      setCopied(true);
      toast.success('Copied');
      setTimeout(() => setCopied(false), 2_500);
    } catch {
      toast.error('Clipboard access denied');
    }
  }

  return (
    <Dialog open={!!created} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Link generated</DialogTitle>
          <DialogDescription>Copy this now: it won&rsquo;t be shown again.</DialogDescription>
        </DialogHeader>

        {created ? (
          <div className="space-y-3">
            <pre className="max-h-24 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs leading-relaxed [overflow-wrap:anywhere]">
              {created.url}
            </pre>
            <p className="text-xs text-muted-foreground">
              Lets the recipient add up to{' '}
              <span className="font-medium text-foreground">{created.maxSessions}</span> number
              {created.maxSessions === 1 ? '' : 's'}, and expires on{' '}
              <span className="font-medium text-foreground">{fmtDate(created.expiresAt)}</span>.
            </p>
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={handleCopy}>
            {copied ? <Check /> : <Copy />}
            {copied ? 'Copied' : 'Copy link'}
          </Button>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Pairing links table (per organization)
// ---------------------------------------------------------------------------

interface InvitesTableProps {
  invites: PairingInviteView[];
  stepUpDone: boolean;
  onStepUpRequired: () => void;
  onRevoked: () => void;
}

function OrgInvitesTable({ invites, stepUpDone, onStepUpRequired, onRevoked }: InvitesTableProps) {
  const [revokeTarget, setRevokeTarget] = useState<PairingInviteView | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  async function handleRevoke() {
    if (!revokeTarget) return;
    setRevokingId(revokeTarget.inviteId);
    try {
      const res = await fetch(`/api/admin/pairing-invites/${revokeTarget.inviteId}/revoke`, {
        method: 'POST',
      });
      if (!res.ok) throw new Error(await res.text());
      toast.success('Link revoked');
      onRevoked();
    } catch (err) {
      toast.error(`Revoke failed: ${(err as Error).message}`);
    } finally {
      setRevokingId(null);
      setRevokeTarget(null);
    }
  }

  const sorted = [...invites].sort((a, b) => {
    const aActive = a.status === 'active';
    const bActive = b.status === 'active';
    if (aActive !== bActive) return aActive ? -1 : 1;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });

  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Label</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Used / max</TableHead>
            <TableHead>Expires</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.length === 0 ? (
            <TableRow>
              <TableCell colSpan={5} className="text-center text-xs text-muted-foreground">
                No pairing links yet
              </TableCell>
            </TableRow>
          ) : (
            sorted.map((invite) => {
              const terminal = invite.status !== 'active';
              return (
                <TableRow key={invite.inviteId} className={cn(terminal && 'opacity-70')}>
                  <TableCell className="text-xs font-medium">
                    {invite.label ?? <span className="text-muted-foreground">, </span>}
                  </TableCell>
                  <TableCell>
                    <span className="inline-flex items-center gap-1.5 text-xs">
                      <span
                        className={cn(
                          'h-1.5 w-1.5 rounded-full',
                          PAIRING_STATUS_DOT[invite.status],
                        )}
                      />
                      <span className="text-foreground">{PAIRING_STATUS_LABEL[invite.status]}</span>
                    </span>
                  </TableCell>
                  <TableCell className="tabular-nums text-xs text-muted-foreground">
                    {invite.sessionIds.length} / {invite.maxSessions}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {fmtDate(invite.expiresAt)}
                  </TableCell>
                  <TableCell>
                    {invite.status === 'active' ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-destructive hover:text-destructive"
                        title="Revoke"
                        disabled={revokingId === invite.inviteId}
                        onClick={() => {
                          if (!stepUpDone) {
                            onStepUpRequired();
                            return;
                          }
                          setRevokeTarget(invite);
                        }}
                      >
                        {revokingId === invite.inviteId ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Ban className="h-3.5 w-3.5" />
                        )}
                        <span className="sr-only">Revoke</span>
                      </Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>

      <AlertDialog open={!!revokeTarget} onOpenChange={(open) => !open && setRevokeTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke pairing link?</AlertDialogTitle>
            <AlertDialogDescription>
              The link &ldquo;{revokeTarget?.label ?? revokeTarget?.inviteId}&rdquo; will stop
              working immediately. Numbers already paired through it are unaffected.
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
    </div>
  );
}

// ---------------------------------------------------------------------------
// OrgCard, one organization: member numbers, attach picker, pairing links
// ---------------------------------------------------------------------------

interface OrgCardProps {
  org: OrganizationView;
  memberSessions: SessionSnapshot[];
  unattachedSessions: SessionSnapshot[];
  invites: PairingInviteView[];
  stepUpDone: boolean;
  onStepUpRequired: () => void;
  onChanged: () => void;
  onSessionsMutated: () => Promise<void> | void;
  onCreateLink: (orgId: string) => void;
}

function OrgCard({
  org,
  memberSessions,
  unattachedSessions,
  invites,
  stepUpDone,
  onStepUpRequired,
  onChanged,
  onSessionsMutated,
  onCreateLink,
}: OrgCardProps) {
  const [pausingId, setPausingId] = useState<string | null>(null);
  const [detachingId, setDetachingId] = useState<string | null>(null);
  const [attachId, setAttachId] = useState('');
  const [attaching, setAttaching] = useState(false);

  async function togglePause(session: SessionSnapshot) {
    setPausingId(session.sessionId);
    try {
      const res = await fetch(`/api/admin/sessions/${session.sessionId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ paused: !session.paused }),
      });
      if (!res.ok) throw new Error(await res.text());
      toast.success(
        session.paused ? `${session.sessionId} resumed` : `${session.sessionId} paused`,
      );
      await onSessionsMutated();
    } catch (err) {
      toast.error(`Update failed: ${(err as Error).message}`);
    } finally {
      setPausingId(null);
    }
  }

  async function detach(sessionId: string) {
    if (!stepUpDone) {
      onStepUpRequired();
      return;
    }
    setDetachingId(sessionId);
    try {
      const res = await fetch(`/api/admin/organizations/${org.orgId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'remove', sessionId }),
      });
      if (!res.ok) throw new Error(await res.text());
      toast.success(`${sessionId} detached from ${org.orgId}`);
      onChanged();
    } catch (err) {
      toast.error(`Detach failed: ${(err as Error).message}`);
    } finally {
      setDetachingId(null);
    }
  }

  async function attach() {
    if (!attachId) return;
    if (!stepUpDone) {
      onStepUpRequired();
      return;
    }
    setAttaching(true);
    try {
      const res = await fetch(`/api/admin/organizations/${org.orgId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'add', sessionId: attachId }),
      });
      if (!res.ok) throw new Error(await res.text());
      toast.success(`${attachId} attached to ${org.orgId}`);
      setAttachId('');
      onChanged();
    } catch (err) {
      toast.error(`Attach failed: ${(err as Error).message}`);
    } finally {
      setAttaching(false);
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2 text-sm">
              {org.label}
              <Badge variant="outline" className="font-normal capitalize">
                {org.strategy}
              </Badge>
            </CardTitle>
            <p className="font-mono text-xs text-muted-foreground">{org.orgId}</p>
          </div>
          <Button size="sm" onClick={() => onCreateLink(org.orgId)}>
            <Link2 />
            New pairing link
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Member numbers */}
        {memberSessions.length === 0 ? (
          <div className="rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">
            No numbers attached yet. Use &ldquo;New pairing link&rdquo; above to have a client add
            one, or attach an existing session below.
          </div>
        ) : (
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Session</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>Phone</TableHead>
                  <TableHead>Budget</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {memberSessions.map((s) => (
                  <TableRow key={s.sessionId}>
                    <TableCell className="font-mono text-xs">{s.sessionId}</TableCell>
                    <TableCell>
                      <span className="inline-flex items-center gap-1.5 text-xs">
                        <span className={cn('h-1.5 w-1.5 rounded-full', STATUS_DOT[s.status])} />
                        <span className="text-foreground">{STATUS_LABEL[s.status]}</span>
                        {s.paused ? (
                          <Badge variant="secondary" className="ml-1">
                            Paused
                          </Badge>
                        ) : null}
                      </span>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {s.phoneE164 ?? ', '}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {fmtBudget(s.budget)}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          title={s.paused ? 'Resume' : 'Pause'}
                          disabled={pausingId === s.sessionId}
                          onClick={() => void togglePause(s)}
                        >
                          {pausingId === s.sessionId ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : s.paused ? (
                            <Play className="h-3.5 w-3.5" />
                          ) : (
                            <Pause className="h-3.5 w-3.5" />
                          )}
                          <span className="sr-only">{s.paused ? 'Resume' : 'Pause'}</span>
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-destructive hover:text-destructive"
                          title="Detach"
                          disabled={detachingId === s.sessionId}
                          onClick={() => void detach(s.sessionId)}
                        >
                          {detachingId === s.sessionId ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Unlink className="h-3.5 w-3.5" />
                          )}
                          <span className="sr-only">Detach</span>
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {/* Attach an existing unattached session */}
        {unattachedSessions.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-border/60 bg-muted/20 p-3">
            <Label htmlFor={`attach-${org.orgId}`} className="text-xs text-muted-foreground">
              Attach existing session
            </Label>
            <select
              id={`attach-${org.orgId}`}
              value={attachId}
              onChange={(e) => setAttachId(e.target.value)}
              className="h-8 flex-1 rounded-md border border-input bg-background px-2 text-xs font-mono shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <option value="">Select a session…</option>
              {unattachedSessions.map((s) => (
                <option key={s.sessionId} value={s.sessionId}>
                  {s.label} ({s.sessionId})
                </option>
              ))}
            </select>
            <Button
              size="sm"
              variant="outline"
              disabled={!attachId || attaching}
              onClick={() => void attach()}
            >
              {attaching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Attach'}
            </Button>
          </div>
        ) : null}

        {/* Pairing links */}
        <div className="space-y-2">
          <h3 className="text-xs font-medium text-muted-foreground">Pairing links</h3>
          <OrgInvitesTable
            invites={invites}
            stepUpDone={stepUpDone}
            onStepUpRequired={onStepUpRequired}
            onRevoked={onChanged}
          />
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// OrganizationsPanel
// ---------------------------------------------------------------------------

export function OrganizationsPanel({
  sessions,
  stepUpDone,
  onStepUpRequired,
  onSessionsMutated,
}: OrganizationsPanelProps) {
  const [orgs, setOrgs] = useState<OrganizationView[]>([]);
  const [invites, setInvites] = useState<PairingInviteView[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [linkOrgId, setLinkOrgId] = useState<string | null>(null);
  const [createdLink, setCreatedLink] = useState<CreatedPairingInvite | null>(null);

  const fetchAll = useCallback(async () => {
    try {
      const [orgsRes, invitesRes] = await Promise.all([
        fetch('/api/admin/organizations', { cache: 'no-store' }),
        fetch('/api/admin/pairing-invites', { cache: 'no-store' }),
      ]);
      if (!orgsRes.ok) throw new Error(await orgsRes.text());
      if (!invitesRes.ok) throw new Error(await invitesRes.text());
      const orgsData = (await orgsRes.json()) as { organizations: OrganizationView[] };
      const invitesData = (await invitesRes.json()) as { invites: PairingInviteView[] };
      setOrgs(orgsData.organizations);
      setInvites(invitesData.invites);
    } catch (err) {
      toast.error(`Failed to load organizations: ${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  const attachedIds = useMemo(() => new Set(orgs.flatMap((o) => o.sessions)), [orgs]);
  const unattachedSessions = useMemo(
    () => sessions.filter((s) => !attachedIds.has(s.sessionId)),
    [sessions, attachedIds],
  );
  const sessionsById = useMemo(() => new Map(sessions.map((s) => [s.sessionId, s])), [sessions]);
  const invitesByOrg = useMemo(() => {
    const map = new Map<string, PairingInviteView[]>();
    for (const invite of invites) {
      map.set(invite.orgId, [...(map.get(invite.orgId) ?? []), invite]);
    }
    return map;
  }, [invites]);

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold tracking-tight">Organizations</h2>
          <p className="text-xs text-muted-foreground">
            An API key binds to an organization, not to a number. The router picks which of its
            numbers sends.
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
          New organization
        </Button>
      </div>

      {loading ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : orgs.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            <Building2 className="mx-auto mb-2 h-6 w-6 text-muted-foreground/60" />
            No organizations yet. Create one, then send a pairing link to attach its first number.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {orgs.map((org) => (
            <OrgCard
              key={org.orgId}
              org={org}
              memberSessions={org.sessions.flatMap((id) => {
                const s = sessionsById.get(id);
                return s ? [s] : [];
              })}
              unattachedSessions={unattachedSessions}
              invites={invitesByOrg.get(org.orgId) ?? []}
              stepUpDone={stepUpDone}
              onStepUpRequired={onStepUpRequired}
              onChanged={() => void fetchAll()}
              onSessionsMutated={onSessionsMutated}
              onCreateLink={(orgId) => {
                if (!stepUpDone) {
                  onStepUpRequired();
                  return;
                }
                setLinkOrgId(orgId);
              }}
            />
          ))}
        </div>
      )}

      <CreateOrgDialog
        open={showCreate}
        onOpenChange={setShowCreate}
        stepUpDone={stepUpDone}
        onCreated={() => void fetchAll()}
      />

      <CreatePairingLinkDialog
        orgId={linkOrgId}
        stepUpDone={stepUpDone}
        onOpenChange={(open) => !open && setLinkOrgId(null)}
        onCreated={(invite) => {
          setCreatedLink(invite);
          void fetchAll();
        }}
      />

      <LinkRevealDialog created={createdLink} onClose={() => setCreatedLink(null)} />
    </section>
  );
}

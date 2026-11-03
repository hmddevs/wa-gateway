'use client';
/**
 * Worker provisioning panel, issues a one-shot 15-minute bootstrap token
 * for the Mac installer to enrol a worker device.
 */
import { useState } from 'react';
import { Cog, Copy, Check } from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

export function WorkerPanel() {
  const [busy, setBusy] = useState(false);
  const [bootstrapToken, setBootstrapToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function issueBootstrap() {
    setBusy(true);
    try {
      const res = await fetch('/api/admin/worker/bootstrap', { method: 'POST' });
      if (!res.ok) throw new Error(await res.text());
      const data = (await res.json()) as { bootstrapToken: string };
      setBootstrapToken(data.bootstrapToken);
      setCopied(false);
      toast.success('Bootstrap token issued (valid for 15 minutes).');
    } catch (err) {
      toast.error(`Bootstrap failed: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleCopy() {
    if (!bootstrapToken) return;
    try {
      await navigator.clipboard.writeText(bootstrapToken);
      setCopied(true);
      toast.success('Copied');
      setTimeout(() => setCopied(false), 2_500);
    } catch {
      toast.error('Clipboard access denied');
    }
  }

  return (
    <Card>
      <CardHeader className="pb-4">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Cog className="h-4 w-4 text-primary" />
          Worker provisioning
        </CardTitle>
        <CardDescription>
          Issue a one-shot 15-minute bootstrap token. Paste it into the Mac installer to enrol a new
          worker device.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Button onClick={issueBootstrap} disabled={busy}>
          <Cog />
          {busy ? 'Issuing…' : 'Issue bootstrap token'}
        </Button>

        {bootstrapToken ? (
          <div className="space-y-2">
            <pre className="max-h-32 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs leading-relaxed [overflow-wrap:anywhere]">
              {bootstrapToken}
            </pre>
            <Button variant="outline" size="sm" onClick={handleCopy}>
              {copied ? <Check /> : <Copy />}
              {copied ? 'Copied' : 'Copy token'}
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

'use client';
/**
 * Automatic WebAuthn step-up page.
 *
 * Fires the passkey authentication flow on mount. On success, redirects to
 * /admin. If no passkey is registered (begin returns non-OK), skips
 * immediately. On failure (cancelled, wrong device, network error) shows an
 * error card with retry and skip options.
 */
import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { startAuthentication } from '@simplewebauthn/browser';
import { Loader2, ShieldCheck } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

export default function StepUpPage() {
  const router = useRouter();
  const [status, setStatus] = useState<'verifying' | 'error'>('verifying');
  const [errorMsg, setErrorMsg] = useState('');

  const attempt = useCallback(async () => {
    setStatus('verifying');
    setErrorMsg('');
    try {
      const beginRes = await fetch('/api/admin/webauthn/authenticate/begin', { method: 'POST' });
      // No credentials registered or not authenticated, skip gracefully.
      if (!beginRes.ok) {
        router.push('/admin');
        return;
      }
      const opts = await beginRes.json();
      const asResp = await startAuthentication(opts);
      const finishRes = await fetch('/api/admin/webauthn/authenticate/finish', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ response: asResp }),
      });
      if (!finishRes.ok) {
        const body = (await finishRes.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${finishRes.status}`);
      }
      router.push('/admin');
    } catch (err) {
      // User cancelled (NotAllowedError) or other error.
      setErrorMsg((err as Error).message);
      setStatus('error');
    }
  }, [router]);

  useEffect(() => {
    void attempt();
  }, [attempt]);

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="h-4 w-4 text-primary" />
            Identity verification
          </CardTitle>
          <CardDescription>Confirm your passkey to unlock sensitive actions.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {status === 'verifying' && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Verifying your identity…
            </div>
          )}
          {status === 'error' && (
            <div className="space-y-3">
              <p className="text-sm text-destructive">{errorMsg}</p>
              <div className="flex items-center gap-3">
                <Button size="sm" onClick={() => void attempt()}>
                  Try again
                </Button>
                <a
                  href="/admin"
                  className="text-xs text-muted-foreground underline underline-offset-2"
                >
                  Skip for now
                </a>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </main>
  );
}

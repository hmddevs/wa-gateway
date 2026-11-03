'use client';
/**
 * Security panel, passkey registration and step-up verification.
 * WebAuthn call sites (`startRegistration`, `startAuthentication`) are
 * preserved exactly.
 */
import { useState } from 'react';
import { ShieldCheck, KeySquare, BadgeCheck } from 'lucide-react';
import { startRegistration, startAuthentication } from '@simplewebauthn/browser';
import { toast } from 'sonner';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

interface SecurityPanelProps {
  passkeyRegistered: boolean;
  stepUpDone: boolean;
  onPasskeyRegistered: () => void;
  onStepUpVerified: () => void;
}

export function SecurityPanel({
  passkeyRegistered,
  stepUpDone,
  onPasskeyRegistered,
  onStepUpVerified,
}: SecurityPanelProps) {
  const [busy, setBusy] = useState(false);

  async function registerPasskey() {
    setBusy(true);
    try {
      const beginRes = await fetch('/api/admin/webauthn/register/begin', { method: 'POST' });
      const opts = await beginRes.json();
      const attResp = await startRegistration(opts);
      const finishRes = await fetch('/api/admin/webauthn/register/finish', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ response: attResp, deviceName: navigator.userAgent }),
      });
      if (!finishRes.ok) throw new Error(await finishRes.text());
      onPasskeyRegistered();
      toast.success('Passkey registered. Sensitive actions are unlocked once verified.');
    } catch (err) {
      toast.error(`Passkey registration failed: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function stepUp() {
    setBusy(true);
    try {
      const beginRes = await fetch('/api/admin/webauthn/authenticate/begin', { method: 'POST' });
      const opts = await beginRes.json();
      const asResp = await startAuthentication(opts);
      const finishRes = await fetch('/api/admin/webauthn/authenticate/finish', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ response: asResp }),
      });
      if (!finishRes.ok) throw new Error(await finishRes.text());
      onStepUpVerified();
      toast.success('Step-up verified, sensitive actions unlocked.');
    } catch (err) {
      toast.error(`Step-up failed: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader className="pb-4">
        <CardTitle className="flex items-center gap-2 text-sm">
          <ShieldCheck className="h-4 w-4 text-primary" />
          Security
        </CardTitle>
        <CardDescription>
          Sensitive actions (session control, key creation, webhook revoke) require a passkey
          step-up.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {!passkeyRegistered ? (
          <>
            <p className="text-sm text-muted-foreground">
              You have no passkey registered. Register one before performing sensitive actions.
            </p>
            <Button onClick={registerPasskey} disabled={busy}>
              <KeySquare />
              {busy ? 'Registering…' : 'Register passkey'}
            </Button>
          </>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              Passkey registered.{' '}
              {stepUpDone
                ? 'Step-up verified for this session.'
                : 'Re-verify to unlock sensitive actions.'}
            </p>
            <Button onClick={stepUp} disabled={busy || stepUpDone}>
              <BadgeCheck />
              {stepUpDone ? 'Verified' : busy ? 'Verifying…' : 'Re-verify with passkey'}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}

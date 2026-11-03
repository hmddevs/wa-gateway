'use client';
/**
 * ErasureDialog, erase a contact's stored data on a given session.
 *
 * Irreversible: deletes messages, chat history, and contacts for the phone.
 * Requires:
 *   1. WebAuthn step-up (stepUpDone).
 *   2. User must type the phone number exactly to enable the confirm button.
 *
 * POST /api/admin/sessions/:id/erase  body: { phone, confirm: true }
 * Response: { erased: { messages: number; consents: number; contacts: number } }
 *
 * British English throughout.
 */
import { useEffect, useState } from 'react';
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ErasureDialogProps {
  open: boolean;
  onClose: () => void;
  sessionId: string;
  stepUpDone: boolean;
  onStepUpRequired: () => void;
}

interface ErasureResult {
  erased: {
    messages: number;
    consents: number;
    contacts: number;
  };
}

// ---------------------------------------------------------------------------
// ErasureDialog
// ---------------------------------------------------------------------------

export function ErasureDialog({
  open,
  onClose,
  sessionId,
  stepUpDone,
  onStepUpRequired,
}: ErasureDialogProps) {
  const [phone, setPhone] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [phoneError, setPhoneError] = useState<string | null>(null);

  // Reset state whenever the dialog opens.
  useEffect(() => {
    if (open) {
      setPhone('');
      setConfirmation('');
      setPhoneError(null);
      setBusy(false);
    }
  }, [open]);

  const E164_RE = /^\+[1-9]\d{6,14}$/;
  const isConfirmed = confirmation === phone && phone.length > 0;
  const isPhoneValid = E164_RE.test(phone);

  async function handleErase() {
    if (!stepUpDone) {
      onStepUpRequired();
      toast.info('Step-up required');
      return;
    }

    if (!isPhoneValid) {
      setPhoneError('Must be E.164 format, e.g. +447700900001');
      return;
    }

    if (!isConfirmed) return;

    setBusy(true);
    try {
      const res = await fetch(`/api/admin/sessions/${encodeURIComponent(sessionId)}/erase`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phone, confirm: true }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = (await res.json()) as ErasureResult;
      toast.success(
        `Erased: ${data.erased.messages} messages, ${data.erased.consents} consents, ${data.erased.contacts} contacts`,
      );
      onClose();
    } catch (err) {
      toast.error(`Erasure failed: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>Erase contact data</AlertDialogTitle>
          <AlertDialogDescription className="space-y-2">
            This action is <span className="font-semibold text-foreground">irreversible</span>. It
            permanently deletes all messages, chat history, and contact entries associated with the
            phone number on session <span className="font-mono text-foreground">{sessionId}</span>.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="erase-phone">Phone number to erase (E.164)</Label>
            <Input
              id="erase-phone"
              value={phone}
              onChange={(e) => {
                setPhone(e.target.value);
                setPhoneError(null);
                // Reset confirmation when phone changes.
                setConfirmation('');
              }}
              placeholder="+447700900001"
              className="font-mono text-sm"
              aria-invalid={phoneError ? true : undefined}
              aria-describedby={phoneError ? 'erase-phone-error' : undefined}
              disabled={busy}
            />
            {phoneError && (
              <p id="erase-phone-error" role="alert" className="text-xs text-destructive">
                {phoneError}
              </p>
            )}
          </div>

          {isPhoneValid && (
            <div className="space-y-1.5">
              <Label htmlFor="erase-confirm">
                Type <span className="font-mono font-semibold text-foreground">{phone}</span> to
                confirm
              </Label>
              <Input
                id="erase-confirm"
                value={confirmation}
                onChange={(e) => setConfirmation(e.target.value)}
                placeholder={phone}
                className="font-mono text-sm"
                disabled={busy}
                aria-describedby="erase-confirm-hint"
              />
              <p id="erase-confirm-hint" className="text-xs text-muted-foreground">
                Must match exactly.
              </p>
            </div>
          )}
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => void handleErase()}
            disabled={!isConfirmed || !isPhoneValid || busy}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90 disabled:pointer-events-none disabled:opacity-50"
          >
            {busy ? 'Erasing…' : 'Erase contact data'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

'use client';
/**
 * Client-side view + polling for the public `/pair/:token` page.
 *
 * A pairing link is reusable and organization-scoped: it can hold several
 * numbers at once, each independently pairing, connected, or offline, up to
 * `maxSessions`. This component owns the whole dynamic page, header, number
 * list, and the "add a number" action, driven entirely by
 * `GET /api/pair/:token/status`, which never returns phone numbers, worker
 * ids, or any other admin field, only what the link's own holder already
 * owns.
 *
 * Polling cadence: 4 s whenever any number is still `pairing` (QRs go stale
 * fast), 15 s once everything has settled, and not at all once the link
 * itself is `expired` or `revoked`. Adding a number re-polls immediately
 * instead of waiting for the next tick.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { CheckCircle2, Loader2, WifiOff, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Separator } from '@/components/ui/separator';

type NumberState = 'pairing' | 'connected' | 'offline';

interface NumberView {
  sessionId: string;
  state: NumberState;
  last4: string | null;
  qrDataUrl?: string;
}

interface StatusBody {
  status: 'active' | 'expired' | 'revoked';
  orgLabel: string;
  maxSessions: number;
  numbers: NumberView[];
}

interface PairingStatusProps {
  token: string;
}

const FAST_POLL_MS = 4_000;
const SLOW_POLL_MS = 15_000;

export function PairingStatus({ token }: PairingStatusProps) {
  const [data, setData] = useState<StatusBody | null>(null);
  const [stale, setStale] = useState(false);
  const [posting, setPosting] = useState(false);
  const stoppedRef = useRef(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const poll = useCallback(async () => {
    if (stoppedRef.current) return;
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    try {
      const res = await fetch(`/api/pair/${encodeURIComponent(token)}/status`, {
        cache: 'no-store',
      });
      if (stoppedRef.current) return;

      if (res.status === 404) {
        // Deliberately identical to a link the server itself has expired:
        // the status endpoint never distinguishes an unknown token from a
        // known-but-expired one, so neither does this page. orgLabel/
        // maxSessions are irrelevant here, the inactive view below never
        // reads them.
        setData({ status: 'expired', orgLabel: '', maxSessions: 0, numbers: [] });
        stoppedRef.current = true;
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const body = (await res.json()) as StatusBody;
      setData(body);
      setStale(false);

      if (body.status !== 'active') {
        stoppedRef.current = true;
        return;
      }
      const fast = body.numbers.some((n) => n.state === 'pairing');
      timeoutRef.current = setTimeout(poll, fast ? FAST_POLL_MS : SLOW_POLL_MS);
    } catch {
      // Transient network failure: keep the last known-good view on screen
      // and just retry soon rather than tearing down the page.
      if (stoppedRef.current) return;
      setStale(true);
      timeoutRef.current = setTimeout(poll, FAST_POLL_MS);
    }
  }, [token]);

  useEffect(() => {
    stoppedRef.current = false;
    void poll();
    return () => {
      stoppedRef.current = true;
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [poll]);

  async function handleAdd() {
    if (posting) return;
    setPosting(true);
    try {
      const res = await fetch(`/api/pair/${encodeURIComponent(token)}/sessions`, {
        method: 'POST',
      });
      if (!res.ok) {
        const message =
          res.status === 409
            ? "This link's number limit has already been reached."
            : res.status === 410
              ? 'This link is no longer active.'
              : res.status === 404
                ? 'This link could not be found.'
                : res.status === 429
                  ? 'Too many attempts, wait a moment and try again.'
                  : 'Could not add a number. Please try again.';
        toast.error(message);
      }
    } catch {
      toast.error('Could not reach the server. Check your connection and try again.');
    } finally {
      setPosting(false);
      // Re-sync regardless of outcome: a concurrent add elsewhere, or the
      // link being revoked mid-request, both need to show up right away.
      stoppedRef.current = false;
      void poll();
    }
  }

  if (!data) return <LoadingSkeleton />;

  if (data.status !== 'active') {
    return (
      <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-16 text-center">
        <XCircle className="h-10 w-10 text-destructive" />
        <p className="text-base font-semibold text-foreground">This link is no longer active</p>
        <p className="max-w-xs text-sm text-muted-foreground">Ask your contact for a new one.</p>
      </div>
    );
  }

  const connectedCount = data.numbers.filter((n) => n.state === 'connected').length;
  const atCapacity = data.numbers.length >= data.maxSessions;

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-[0.25em] text-muted-foreground">
          {data.orgLabel}
        </p>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">
          Connect your WhatsApp numbers
        </h1>
        <p className="text-sm text-muted-foreground">
          Add each WhatsApp number your team sends from. Scan its QR code once and it stays
          connected.
        </p>
        {/* Scoped to the counter, not the page: this re-renders every poll,
            and announcing the whole document each time would make the page
            unusable with a screen reader. */}
        <p aria-live="polite" className="text-sm font-medium text-foreground">
          {connectedCount} of {data.maxSessions} numbers connected
        </p>
      </header>

      <Separator />

      {data.numbers.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No numbers added yet. Tap &ldquo;Add a number&rdquo; to get started.
        </p>
      ) : (
        <ul className="space-y-4">
          {data.numbers.map((n, i) => (
            <li key={n.sessionId}>
              <NumberCard number={n} position={i + 1} />
            </li>
          ))}
        </ul>
      )}

      <div className="space-y-2">
        <Button onClick={handleAdd} disabled={posting || atCapacity} className="w-full" size="lg">
          {posting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" /> Adding…
            </>
          ) : (
            'Add a number'
          )}
        </Button>
        {atCapacity && (
          <p className="text-center text-xs text-muted-foreground">
            This link allows up to {data.maxSessions} numbers, and that limit has been reached.
          </p>
        )}
        {stale && !atCapacity && (
          <p className="text-center text-xs text-muted-foreground">
            Reconnecting&hellip; retrying in the background.
          </p>
        )}
      </div>
    </div>
  );
}

function NumberCard({ number, position }: { number: NumberView; position: number }) {
  if (number.state === 'connected') {
    return (
      <Card>
        <CardContent className="flex items-center justify-between gap-3 p-4">
          <div className="flex items-center gap-3">
            <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-500" />
            <div>
              <p className="text-sm font-medium text-foreground">Number {position}</p>
              <p className="text-sm text-muted-foreground">•••• {number.last4 ?? '····'}</p>
            </div>
          </div>
          <Badge variant="secondary">Connected</Badge>
        </CardContent>
      </Card>
    );
  }

  if (number.state === 'offline') {
    return (
      <Card className="border-dashed">
        <CardContent className="flex items-center justify-between gap-3 p-4">
          <div className="flex items-center gap-3">
            <WifiOff className="h-5 w-5 shrink-0 text-muted-foreground" />
            <div>
              <p className="text-sm font-medium text-foreground">Number {position}</p>
              <p className="text-sm text-muted-foreground">
                {number.last4 ? `•••• ${number.last4}` : 'Disconnected'}
              </p>
            </div>
          </div>
          <Badge variant="outline" className="text-muted-foreground">
            Offline
          </Badge>
        </CardContent>
      </Card>
    );
  }

  // Pairing: the number this link just added, waiting to be scanned.
  return (
    <Card>
      <CardContent className="space-y-4 p-4">
        <p className="text-sm font-medium text-foreground">
          Number {position}, waiting to be scanned
        </p>
        {number.qrDataUrl ? (
          // QR codes need a light, high-contrast background to scan reliably,
          // in either theme, so this box stays white regardless of mode.
          <div className="mx-auto flex h-64 w-64 max-w-full items-center justify-center rounded-lg border bg-white p-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={number.qrDataUrl} alt="WhatsApp pairing QR code" className="h-full w-full" />
          </div>
        ) : (
          <div className="mx-auto flex h-64 w-64 max-w-full flex-col items-center justify-center gap-2 rounded-lg border text-sm text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
            Generating QR code…
          </div>
        )}
        <ol className="space-y-1 text-sm text-muted-foreground">
          <li>1. Open WhatsApp on the phone with this number.</li>
          <li>2. Tap Settings, then Linked devices.</li>
          <li>3. Tap Link a device.</li>
          <li>4. Point that phone&rsquo;s camera at the QR code above.</li>
        </ol>
      </CardContent>
    </Card>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-7 w-64 max-w-full" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>
      <Skeleton className="h-64 w-full rounded-lg" />
    </div>
  );
}

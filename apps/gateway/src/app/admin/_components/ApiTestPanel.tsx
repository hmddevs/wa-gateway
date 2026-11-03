'use client';
import { useCallback, useEffect, useState } from 'react';
import { Send, Loader2, CheckCircle2, AlertTriangle, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { ApiKeyView } from '../_types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type BodyKind = 'text' | 'image' | 'document';
type Channel = 'notification' | 'transactional' | 'internal';

interface TestResult {
  ok: boolean;
  status: number;
  latencyMs?: number;
  messageId?: string;
  code?: string;
  error?: string;
  raw: string;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ApiTestPanelProps {
  stepUpDone: boolean;
  onStepUpRequired: () => void;
}

// ---------------------------------------------------------------------------
// Shared native-select style
// ---------------------------------------------------------------------------

const selectCls =
  'flex h-8 w-full rounded-md border border-input bg-transparent px-3 py-1 text-xs shadow-sm transition-colors focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50';

const textareaCls =
  'flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-xs shadow-sm transition-colors placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50 resize-none';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ApiTestPanel({ stepUpDone, onStepUpRequired }: ApiTestPanelProps) {
  // null = loading, [] = loaded (empty), [...] = loaded with keys.
  const [keys, setKeys] = useState<ApiKeyView[] | null>(null);
  const [keysError, setKeysError] = useState<string | null>(null);

  const [keyId, setKeyId] = useState('');
  const [to, setTo] = useState('');
  const [channel, setChannel] = useState<Channel>('transactional');
  const [purpose, setPurpose] = useState('');
  const [bodyKind, setBodyKind] = useState<BodyKind>('text');

  // text
  const [text, setText] = useState('');
  // image / document
  const [url, setUrl] = useState('');
  const [caption, setCaption] = useState('');
  const [filename, setFilename] = useState('');

  const [purposeTouched, setPurposeTouched] = useState(false);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);

  const purposeError = purposeTouched && !purpose;

  const loadKeys = useCallback(async () => {
    setKeys(null);
    setKeysError(null);
    try {
      const r = await fetch('/api/admin/keys', { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = (await r.json()) as { keys: ApiKeyView[] };
      const active = d.keys.filter((k) => !k.revokedAt);
      setKeys(active);
      if (active.length > 0) setKeyId(active[0]!.keyId);
    } catch (err: unknown) {
      const msg = (err as Error).message ?? 'Unknown error';
      setKeysError(`Failed to load API keys, ${msg}`);
      toast.error('Failed to load API keys');
    }
  }, []);

  useEffect(() => {
    void loadKeys();
  }, [loadKeys]);

  const buildBody = useCallback(() => {
    switch (bodyKind) {
      case 'text':
        return { kind: 'text' as const, text };
      case 'image':
        return { kind: 'image' as const, url, ...(caption ? { caption } : {}) };
      case 'document':
        return {
          kind: 'document' as const,
          url,
          ...(filename ? { filename } : {}),
          ...(caption ? { caption } : {}),
        };
    }
  }, [bodyKind, text, url, caption, filename]);

  const handleSend = async () => {
    if (!stepUpDone) {
      onStepUpRequired();
      return;
    }

    setPurposeTouched(true);

    if (!purpose) {
      setResult({ ok: false, status: 0, error: 'Purpose is required before sending.', raw: '' });
      return;
    }

    const body = buildBody();
    if (!body) {
      setResult({ ok: false, status: 0, error: 'Invalid request body', raw: '' });
      return;
    }

    setSending(true);
    setResult(null);

    const t0 = Date.now();
    try {
      const res = await fetch('/api/admin/test-send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          keyId,
          to,
          channel,
          purpose,
          body,
        }),
      });
      const clientLatency = Date.now() - t0;
      const responseText = await res.text();
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(responseText) as Record<string, unknown>;
      } catch {
        /* raw */
      }
      setResult({
        ok: res.ok,
        status: res.status,
        latencyMs: typeof parsed.latencyMs === 'number' ? parsed.latencyMs : clientLatency,
        messageId: typeof parsed.messageId === 'string' ? parsed.messageId : undefined,
        code: typeof parsed.code === 'string' ? parsed.code : undefined,
        error: typeof parsed.error === 'string' ? parsed.error : undefined,
        raw: responseText,
      });
    } catch (err: unknown) {
      setResult({ ok: false, status: 0, error: (err as Error).message, raw: '' });
    } finally {
      setSending(false);
    }
  };

  const selectedKey = keys?.find((k) => k.keyId === keyId);

  return (
    <div className="space-y-4">
      {/* Request builder */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">API Test Panel</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Key selector */}
          <div className="space-y-1.5">
            <Label className="text-xs">API key</Label>
            {keysError ? (
              <div className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-2 text-xs text-destructive">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                <span className="flex-1">{keysError}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-xs"
                  onClick={() => void loadKeys()}
                >
                  <RefreshCw className="mr-1 h-3 w-3" />
                  Retry
                </Button>
              </div>
            ) : keys === null ? (
              <p className="text-xs text-muted-foreground">Loading keys…</p>
            ) : keys.length === 0 ? (
              <p className="text-xs text-muted-foreground">No active API keys found.</p>
            ) : (
              <select
                className={selectCls}
                value={keyId}
                onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setKeyId(e.target.value)}
              >
                {keys.map((k) => (
                  <option key={k.keyId} value={k.keyId}>
                    {k.label}, {k.sessionId} · {k.env}
                  </option>
                ))}
              </select>
            )}
            {selectedKey && (
              <div className="flex flex-wrap gap-1 pt-0.5">
                {selectedKey.scopes.map((s) => (
                  <Badge key={s} variant="outline" className="text-[10px] py-0">
                    {s}
                  </Badge>
                ))}
              </div>
            )}
          </div>

          {/* To */}
          <div className="space-y-1.5">
            <Label className="text-xs">To (E.164)</Label>
            <Input
              className="h-8 text-xs font-mono"
              placeholder="+447700900123"
              value={to}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTo(e.target.value)}
            />
          </div>

          {/* Channel */}
          <div className="space-y-1.5">
            <Label className="text-xs">Channel</Label>
            <select
              className={selectCls}
              value={channel}
              onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
                setChannel(e.target.value as Channel)
              }
            >
              <option value="transactional">transactional</option>
              <option value="notification">notification</option>
              <option value="internal">internal</option>
            </select>
          </div>

          {/* Purpose */}
          <div className="space-y-1.5">
            <Label htmlFor="test-purpose" className="text-xs">
              Purpose
            </Label>
            <select
              id="test-purpose"
              className={selectCls}
              value={purpose}
              aria-describedby={purposeError ? 'test-purpose-error' : undefined}
              aria-invalid={purposeError ? true : undefined}
              onChange={(e: React.ChangeEvent<HTMLSelectElement>) => {
                setPurpose(e.target.value);
                setPurposeTouched(true);
              }}
            >
              <option value="" disabled hidden>
                Select purpose…
              </option>
              <option value="otp">OTP (one-time password)</option>
              <option value="magic_link">Magic link</option>
              <option value="transactional">Transactional</option>
              <option value="notification">Notification</option>
              <option value="support">Support</option>
              <option value="marketing">Marketing</option>
              <option value="other">Other</option>
            </select>
            {purposeError ? (
              <p id="test-purpose-error" role="alert" className="text-xs text-destructive">
                Purpose is required.
              </p>
            ) : null}
          </div>

          {/* Body kind */}
          <div className="space-y-1.5">
            <Label className="text-xs">Body kind</Label>
            <select
              className={selectCls}
              value={bodyKind}
              onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
                setBodyKind(e.target.value as BodyKind)
              }
            >
              <option value="text">text</option>
              <option value="image">image</option>
              <option value="document">document</option>
            </select>
          </div>

          {/* Body fields */}
          {bodyKind === 'text' && (
            <div className="space-y-1.5">
              <Label className="text-xs">Text</Label>
              <textarea
                className={textareaCls}
                rows={3}
                placeholder="Message text…"
                value={text}
                onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setText(e.target.value)}
              />
            </div>
          )}

          {(bodyKind === 'image' || bodyKind === 'document') && (
            <>
              <div className="space-y-1.5">
                <Label className="text-xs">URL</Label>
                <Input
                  className="h-8 text-xs font-mono"
                  placeholder="https://…"
                  value={url}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setUrl(e.target.value)}
                />
              </div>
              {bodyKind === 'document' && (
                <div className="space-y-1.5">
                  <Label className="text-xs">Filename (optional)</Label>
                  <Input
                    className="h-8 text-xs"
                    placeholder="file.pdf"
                    value={filename}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                      setFilename(e.target.value)
                    }
                  />
                </div>
              )}
              <div className="space-y-1.5">
                <Label className="text-xs">Caption (optional)</Label>
                <Input
                  className="h-8 text-xs"
                  value={caption}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCaption(e.target.value)}
                />
              </div>
            </>
          )}

          <Button
            className="w-full"
            size="sm"
            onClick={handleSend}
            disabled={sending || keys === null || !!keysError || !keyId || !purpose}
          >
            {sending ? (
              <>
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                Sending&hellip;
              </>
            ) : (
              <>
                <Send className="mr-1.5 h-3.5 w-3.5" />
                Send test message
              </>
            )}
          </Button>

          {!stepUpDone && (
            <p className="text-center text-xs text-muted-foreground">
              Passkey verification required to send.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Response */}
      {result && (
        <Card
          className={cn('border', result.ok ? 'border-emerald-500/40' : 'border-destructive/40')}
        >
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                {result.ok ? (
                  <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                ) : (
                  <AlertTriangle className="h-4 w-4 text-destructive" />
                )}
                <span className="text-sm font-medium">HTTP {result.status}</span>
                {result.code && (
                  <Badge variant="outline" className="text-[10px] py-0 font-mono">
                    {result.code}
                  </Badge>
                )}
              </div>
              {result.latencyMs !== undefined && (
                <span className="text-xs text-muted-foreground">{result.latencyMs} ms</span>
              )}
            </div>
          </CardHeader>
          <CardContent className="pt-0 space-y-2">
            {result.messageId && (
              <p className="text-xs text-muted-foreground font-mono">
                messageId: {result.messageId}
              </p>
            )}
            {result.error && <p className="text-xs text-destructive">{result.error}</p>}
            <pre className="overflow-x-auto rounded bg-muted px-3 py-2 text-[11px] leading-relaxed">
              {(() => {
                try {
                  return JSON.stringify(JSON.parse(result.raw), null, 2);
                } catch {
                  return result.raw;
                }
              })()}
            </pre>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

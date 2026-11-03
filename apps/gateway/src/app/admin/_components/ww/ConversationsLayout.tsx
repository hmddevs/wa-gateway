'use client';
/**
 * ConversationsLayout, 3-pane WhatsApp Web shell.
 *
 * Owns: session selection, thread selection, SSE subscription, patchThread,
 * contact roster fetch, search debounce, and mobile single-pane navigation.
 *
 * Passes state down to ThreadRail and ConversationPane as props.
 * InfoPane is managed inside ConversationPane (per-thread concern).
 *
 * Preserves all side-effects from the original ConversationsPanel:
 *   - SSE EventSource with seenSseIds dedup set
 *   - message_status patch via setSseStatusPatch
 *   - patchThread for live rail updates
 *   - IntersectionObserver pagination (inside ThreadRail)
 *   - NewConversationDialog (E.164 entry)
 *
 * Layout:
 *   ≥1024px, 3-pane side-by-side (rail | centre |, info via Dialog)
 *   <1024px, single pane at a time; back button navigates rail → pane
 *
 * Import this file in AdminClient.tsx instead of ConversationsPanel.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ThreadRail } from './ThreadRail';
import { ConversationPane } from './ConversationPane';
import type { AdminThreadSummary, AdminThreadMessage, AdminMessageStatus } from '../../_types';
import type { AdminStreamEnvelope } from '@hmddevs/protocol';
import type { ContactEntry } from './ThreadRail';
import './theme.css';

// ---------------------------------------------------------------------------
// Session option shape (matches WebhooksPanel / original ConversationsPanel)
// ---------------------------------------------------------------------------

export interface SessionOption {
  sessionId: string;
  label: string;
  status?: string;
}

// ---------------------------------------------------------------------------
// useDebounced
// ---------------------------------------------------------------------------

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}

// ---------------------------------------------------------------------------
// useThreadsList, paginated thread list with search + SSE patching
// ---------------------------------------------------------------------------

interface ThreadsState {
  items: AdminThreadSummary[];
  nextCursor: string | null;
  loading: boolean;
  error: string | null;
}

function useThreadsList(sessionId: string | null, search: string) {
  const [state, setState] = useState<ThreadsState>({
    items: [],
    nextCursor: null,
    loading: false,
    error: null,
  });

  const prevKey = useRef<string>('');
  const currentKey = `${sessionId ?? ''}::${search}`;
  const abortRef = useRef<AbortController | null>(null);

  const fetchPage = useCallback(
    async (cursor: string | null, replace: boolean) => {
      if (!sessionId) return;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setState((s) => ({ ...s, loading: true, error: null }));
      try {
        const params = new URLSearchParams({ limit: '50' });
        if (cursor) params.set('cursor', cursor);
        if (search.trim().length >= 2) params.set('search', search.trim());
        const res = await fetch(`/api/admin/sessions/${sessionId}/threads?${params.toString()}`, {
          credentials: 'include',
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        const data = (await res.json()) as {
          items: AdminThreadSummary[];
          nextCursor: string | null;
        };
        setState((s) => ({
          items: replace ? data.items : [...s.items, ...data.items],
          nextCursor: data.nextCursor,
          loading: false,
          error: null,
        }));
      } catch (err) {
        if ((err as DOMException).name === 'AbortError') return;
        const msg = (err as Error).message;
        setState((s) => ({ ...s, loading: false, error: msg }));
        toast.error(`Failed to load conversations: ${msg}`);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessionId, search],
  );

  useEffect(() => {
    if (currentKey === prevKey.current) return;
    prevKey.current = currentKey;
    abortRef.current?.abort();
    setState({ items: [], nextCursor: null, loading: false, error: null });
    if (sessionId) {
      void fetchPage(null, true);
    }
    return () => {
      abortRef.current?.abort();
    };
  }, [currentKey, sessionId, fetchPage]);

  const loadMore = useCallback(() => {
    if (state.nextCursor && !state.loading) {
      void fetchPage(state.nextCursor, false);
    }
  }, [state.nextCursor, state.loading, fetchPage]);

  const patchThread = useCallback(
    (
      counterparty: string,
      patch: Partial<AdminThreadSummary>,
      knownCounterparties: Set<string>,
    ) => {
      if (!knownCounterparties.has(counterparty)) {
        void fetchPage(null, true);
        return;
      }
      setState((s) => ({
        ...s,
        items: s.items.map((item) =>
          item.counterparty === counterparty ? { ...item, ...patch } : item,
        ),
      }));
    },
    [fetchPage],
  );

  return { ...state, loadMore, patchThread };
}

// ---------------------------------------------------------------------------
// useContacts, fetches the per-session contact roster (new contacts repo)
// ---------------------------------------------------------------------------

function useContacts(sessionId: string | null): Map<string, ContactEntry> {
  const [contacts, setContacts] = useState<Map<string, ContactEntry>>(() => new Map());

  useEffect(() => {
    if (!sessionId) {
      setContacts(new Map());
      return;
    }
    const controller = new AbortController();

    fetch(`/api/admin/sessions/${sessionId}/contacts`, {
      credentials: 'include',
      cache: 'no-store',
      signal: controller.signal,
    })
      .then((res) => {
        if (!res.ok) return;
        return res.json() as Promise<{ contacts: ContactEntry[] }>;
      })
      .then((data) => {
        if (!data) return;
        const map = new Map<string, ContactEntry>();
        for (const c of data.contacts) {
          if (!c.e164) continue;
          map.set(c.e164, c);
        }
        setContacts(map);
      })
      .catch((err: unknown) => {
        if ((err as DOMException).name === 'AbortError') return;
        // Non-fatal, threads fall back to E.164 display and initials avatars.
      });

    return () => controller.abort();
  }, [sessionId]);

  return contacts;
}

// ---------------------------------------------------------------------------
// E.164 validation for NewConversationDialog
// ---------------------------------------------------------------------------

const E164_RE = /^\+[1-9]\d{7,14}$/;

interface NewConversationDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: (phone: string) => void;
}

function NewConversationDialog({ open, onClose, onConfirm }: NewConversationDialogProps) {
  const [phone, setPhone] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setPhone('');
      setError(null);
    }
  }, [open]);

  function handleConfirm() {
    if (!E164_RE.test(phone)) {
      setError('Enter a valid E.164 number, e.g. +447700900000.');
      return;
    }
    onConfirm(phone);
    onClose();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>New conversation</DialogTitle>
        </DialogHeader>
        <div className="space-y-1.5 py-2">
          <Label htmlFor="new-conv-phone">Phone number</Label>
          <Input
            id="new-conv-phone"
            value={phone}
            onChange={(e) => {
              setPhone(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleConfirm();
              }
            }}
            placeholder="+447700900000"
            autoComplete="off"
            aria-describedby={error ? 'new-conv-phone-error' : undefined}
          />
          {error && (
            <p id="new-conv-phone-error" className="text-xs text-destructive">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleConfirm}>Open conversation</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// SessionPicker, minimal session selector for the top of the left rail
// ---------------------------------------------------------------------------

interface SessionPickerProps {
  sessions: SessionOption[];
  selectedSessionId: string | null;
  onChange: (id: string) => void;
}

function SessionPicker({ sessions, selectedSessionId, onChange }: SessionPickerProps) {
  return (
    <div
      className="flex items-center gap-2 px-3 py-2 shrink-0"
      style={{ backgroundColor: 'var(--ww-header-bg)', borderBottom: '1px solid var(--ww-border)' }}
    >
      <span
        className="text-[0.6rem] font-semibold uppercase tracking-widest shrink-0"
        style={{ color: 'var(--ww-text-muted)' }}
      >
        Session
      </span>
      <select
        value={selectedSessionId ?? ''}
        onChange={(e) => onChange(e.target.value)}
        aria-label="Select session"
        className="flex-1 rounded-md border-0 bg-transparent py-0.5 text-xs focus:outline-none focus:ring-1 focus:ring-[var(--ww-green)] truncate"
        style={{ color: 'var(--ww-text-primary)' }}
      >
        {sessions.map((s) => (
          <option key={s.sessionId} value={s.sessionId}>
            {s.label} ({s.sessionId})
          </option>
        ))}
      </select>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ConversationsLayout, exported root component
// ---------------------------------------------------------------------------

interface ConversationsLayoutProps {
  sessions: SessionOption[];
  stepUpDone: boolean;
  onStepUpRequired: () => void;
}

export function ConversationsLayout({
  sessions,
  stepUpDone,
  onStepUpRequired,
}: ConversationsLayoutProps) {
  const defaultSessionId = useMemo(() => {
    const connected = sessions.find((s) => s.status === 'connected');
    return connected?.sessionId ?? sessions[0]?.sessionId ?? null;
  }, [sessions]);

  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(defaultSessionId);
  const [selectedCounterparty, setSelectedCounterparty] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [newConvOpen, setNewConvOpen] = useState(false);
  // Mobile: which pane is visible, 'rail' | 'pane'
  const [mobileView, setMobileView] = useState<'rail' | 'pane'>('rail');

  const debouncedSearch = useDebounced(search, 250);
  const {
    items: threadItems,
    nextCursor: threadNextCursor,
    loading: threadLoading,
    loadMore: threadLoadMore,
    patchThread,
  } = useThreadsList(selectedSessionId, debouncedSearch);

  const contacts = useContacts(selectedSessionId);

  // SSE state
  const [ssePushed, setSsePushed] = useState<AdminThreadMessage[]>([]);
  const [sseStatusPatch, setSseStatusPatch] = useState<Map<string, AdminMessageStatus>>(
    () => new Map(),
  );

  const knownCounterparties = useMemo(
    () => new Set(threadItems.map((t) => t.counterparty)),
    [threadItems],
  );

  // Stable refs for the SSE closure
  const knownCpRef = useRef(knownCounterparties);
  const threadItemsRef = useRef(threadItems);
  const selectedCpRef = useRef(selectedCounterparty);
  useEffect(() => {
    knownCpRef.current = knownCounterparties;
  }, [knownCounterparties]);
  useEffect(() => {
    threadItemsRef.current = threadItems;
  }, [threadItems]);
  useEffect(() => {
    selectedCpRef.current = selectedCounterparty;
  }, [selectedCounterparty]);

  // Clear SSE buffers on thread/session change
  useEffect(() => {
    setSsePushed([]);
    setSseStatusPatch(new Map());
  }, [selectedCounterparty, selectedSessionId]);

  // SSE subscription, preserved verbatim from original ConversationsPanel
  const seenSseIds = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!selectedSessionId) return;
    seenSseIds.current = new Set();

    const es = new EventSource(`/api/admin/sessions/${selectedSessionId}/stream`);

    es.onmessage = (evt: MessageEvent<string>) => {
      let envelope: AdminStreamEnvelope;
      try {
        envelope = JSON.parse(evt.data) as AdminStreamEnvelope;
      } catch {
        return;
      }
      const { event } = envelope;

      if (event.kind === 'inbound' || event.kind === 'chat_event') {
        const dedupeKey =
          event.kind === 'inbound' ? `inbound:${event.messageId}` : `chat:${event.waMessageId}`;
        if (seenSseIds.current.has(dedupeKey)) return;
        seenSseIds.current.add(dedupeKey);

        const cp: string | null = event.counterpartyE164;
        const direction: 'in' | 'out' =
          event.kind === 'inbound' ? 'in' : event.direction === 'out_device' ? 'out' : 'in';
        const preview = event.preview;
        const ts = event.ts;

        if (cp) {
          patchThread(
            cp,
            {
              lastMessageAt: ts,
              lastMessagePreview: preview,
              unreadCount:
                cp !== selectedCpRef.current && direction === 'in'
                  ? knownCpRef.current.has(cp)
                    ? (threadItemsRef.current.find((t) => t.counterparty === cp)?.unreadCount ??
                        0) + 1
                    : 1
                  : undefined,
            },
            knownCpRef.current,
          );
        }

        if (cp === selectedCpRef.current) {
          const msgId = event.kind === 'inbound' ? event.messageId : event.waMessageId;
          const newMsg: AdminThreadMessage = {
            messageId: msgId,
            direction,
            ts,
            body: { kind: 'text', text: preview },
            status: undefined,
          };
          setSsePushed((prev) => {
            if (prev.some((m) => m.messageId === msgId)) return prev;
            return [...prev, newMsg];
          });
        }
      } else if (event.kind === 'message_status') {
        if (seenSseIds.current.has(`status:${event.messageId}:${event.status}`)) return;
        seenSseIds.current.add(`status:${event.messageId}:${event.status}`);
        setSseStatusPatch((prev) => {
          const next = new Map(prev);
          next.set(event.messageId, event.status);
          return next;
        });
      }
    };

    es.onerror = () => {
      // EventSource reconnects automatically.
    };

    return () => {
      es.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSessionId]);

  function handleSessionChange(id: string) {
    setSelectedSessionId(id);
    setSelectedCounterparty(null);
    setSearch('');
    setMobileView('rail');
  }

  function handleSelectCounterparty(cp: string) {
    setSelectedCounterparty(cp);
    setMobileView('pane');
  }

  // Empty state
  if (sessions.length === 0) {
    return (
      <section className="space-y-4">
        <div>
          <h2 className="text-base font-semibold tracking-tight">Conversations</h2>
          <p className="text-xs text-muted-foreground">
            Browse inbound and outbound message threads per session.
          </p>
        </div>
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No sessions yet, create one in the Sessions tab.
          </CardContent>
        </Card>
      </section>
    );
  }

  const rail = (
    <div className="flex h-full flex-col overflow-hidden">
      <SessionPicker
        sessions={sessions}
        selectedSessionId={selectedSessionId}
        onChange={handleSessionChange}
      />
      <ThreadRail
        items={threadItems}
        nextCursor={threadNextCursor}
        loading={threadLoading}
        loadMore={threadLoadMore}
        search={search}
        onSearchChange={setSearch}
        selectedCounterparty={selectedCounterparty}
        onSelect={handleSelectCounterparty}
        onNewConversation={() => setNewConvOpen(true)}
        contacts={contacts}
      />
    </div>
  );

  const centrePane = (
    <ConversationPane
      sessionId={selectedSessionId}
      counterparty={selectedCounterparty}
      stepUpDone={stepUpDone}
      onStepUpRequired={onStepUpRequired}
      ssePushed={ssePushed}
      sseStatusPatch={sseStatusPatch}
      contacts={contacts}
    />
  );

  return (
    <section className="ww space-y-0">
      {/* Desktop 3-pane (≥1024px) */}
      <div
        className="hidden lg:flex overflow-hidden rounded-lg border"
        style={{
          height: '80vh',
          borderColor: 'var(--ww-border)',
        }}
      >
        {/* Left rail */}
        <div className="w-[360px] shrink-0 overflow-hidden">{rail}</div>
        {/* Centre */}
        <div className="flex-1 overflow-hidden">{centrePane}</div>
      </div>

      {/* Mobile / tablet (<1024px), single pane at a time */}
      <div
        className="lg:hidden overflow-hidden rounded-lg border"
        style={{
          height: '85vh',
          borderColor: 'var(--ww-border)',
        }}
      >
        {mobileView === 'rail' ? (
          <div className="h-full">{rail}</div>
        ) : (
          <div className="flex h-full flex-col">
            {/* Back button bar */}
            <div
              className="flex items-center gap-2 px-3 py-2 shrink-0"
              style={{
                backgroundColor: 'var(--ww-header-bg)',
                borderBottom: '1px solid var(--ww-border)',
              }}
            >
              <button
                type="button"
                aria-label="Back to conversations"
                onClick={() => setMobileView('rail')}
                className="flex items-center gap-1.5 text-sm focus:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded"
                style={{ color: 'var(--ww-green)' }}
              >
                <ArrowLeft className="h-4 w-4" />
                Conversations
              </button>
            </div>
            <div className="flex-1 overflow-hidden">{centrePane}</div>
          </div>
        )}
      </div>

      <NewConversationDialog
        open={newConvOpen}
        onClose={() => setNewConvOpen(false)}
        onConfirm={(phone) => handleSelectCounterparty(phone)}
      />
    </section>
  );
}

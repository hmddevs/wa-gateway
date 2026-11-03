'use client';
/**
 * ConversationPane, centre column of the WW-style layout.
 *
 * Three regions:
 *   - Sticky header: avatar, name, last-seen / e164, info toggle
 *   - Bubble list: scrollable, day separators, consecutive-author grouping
 *   - Sticky composer at the bottom
 *
 * SSE push, optimistic UI, scroll management, and send wiring all live here
 * (ported verbatim from the original ThreadView in ConversationsPanel.tsx).
 */
import React, {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Info, Users } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { MessageBubble, previewText } from './MessageBubble';
import { Composer } from './Composer';
import { Avatar, groupLabel } from './ThreadRail';
import { InfoPane } from './InfoPane';
import type { AdminThreadMessage, AdminMessageStatus, AdminThreadMessageBody } from '../../_types';
import type { ContactEntry } from './ThreadRail';

// ---------------------------------------------------------------------------
// Day-separator helpers
// ---------------------------------------------------------------------------

function calendarKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

const DAY_FMT = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

function dayLabel(date: Date): string {
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const key = calendarKey(date);
  if (key === calendarKey(today)) return 'Today';
  if (key === calendarKey(yesterday)) return 'Yesterday';
  return DAY_FMT.format(date);
}

// ---------------------------------------------------------------------------
// useThreadMessages, paginated messages for one thread
// ---------------------------------------------------------------------------

interface MessagesState {
  items: AdminThreadMessage[];
  nextCursor: string | null;
  loading: boolean;
  error: string | null;
}

/** Base64url encode a JID for the groups endpoint path. */
function jidToB64(jid: string): string {
  return btoa(jid).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function useThreadMessages(sessionId: string | null, counterparty: string | null) {
  const [state, setState] = useState<MessagesState>({
    items: [],
    nextCursor: null,
    loading: false,
    error: null,
  });

  const prevKey = useRef<string>('');
  const currentKey = `${sessionId ?? ''}::${counterparty ?? ''}`;
  const abortRef = useRef<AbortController | null>(null);

  const fetchPage = useCallback(
    async (cursor: string | null, prepend: boolean) => {
      if (!sessionId || !counterparty) return;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setState((s) => ({ ...s, loading: true, error: null }));
      try {
        const params = new URLSearchParams({ limit: '50' });
        if (cursor) params.set('cursor', cursor);
        const isGroup = counterparty.endsWith('@g.us');
        const threadPath = isGroup
          ? `/api/admin/sessions/${sessionId}/threads/groups/${jidToB64(counterparty)}/messages`
          : `/api/admin/sessions/${sessionId}/threads/${encodeURIComponent(counterparty)}`;
        const res = await fetch(`${threadPath}?${params.toString()}`, {
          credentials: 'include',
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        const data = (await res.json()) as {
          items: AdminThreadMessage[];
          nextCursor: string | null;
        };
        const reversed = [...data.items].reverse();
        setState((s) => ({
          items: prepend ? [...reversed, ...s.items] : reversed,
          nextCursor: data.nextCursor,
          loading: false,
          error: null,
        }));
      } catch (err) {
        if ((err as DOMException).name === 'AbortError') return;
        const msg = (err as Error).message;
        setState((s) => ({ ...s, loading: false, error: msg }));
        toast.error(`Failed to load messages: ${msg}`);
      }
    },
    [sessionId, counterparty],
  );

  useEffect(() => {
    if (currentKey === prevKey.current) return;
    prevKey.current = currentKey;
    abortRef.current?.abort();
    setState({ items: [], nextCursor: null, loading: false, error: null });
    if (sessionId && counterparty) {
      void fetchPage(null, false);
    }
    return () => {
      abortRef.current?.abort();
    };
  }, [currentKey, sessionId, counterparty, fetchPage]);

  const loadMore = useCallback(() => {
    if (state.nextCursor && !state.loading) {
      void fetchPage(state.nextCursor, true);
    }
  }, [state.nextCursor, state.loading, fetchPage]);

  const reload = useCallback(() => {
    void fetchPage(null, false);
  }, [fetchPage]);

  return { ...state, loadMore, reload };
}

// ---------------------------------------------------------------------------
// ConversationPane props
// ---------------------------------------------------------------------------

interface ConversationPaneProps {
  sessionId: string | null;
  counterparty: string | null;
  stepUpDone: boolean;
  onStepUpRequired: () => void;
  ssePushed: AdminThreadMessage[];
  sseStatusPatch: Map<string, AdminMessageStatus>;
  contacts: Map<string, ContactEntry>;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ConversationPane({
  sessionId,
  counterparty,
  stepUpDone,
  onStepUpRequired,
  ssePushed,
  sseStatusPatch,
  contacts,
}: ConversationPaneProps) {
  const { items, nextCursor, loading, loadMore } = useThreadMessages(sessionId, counterparty);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [replyTo, setReplyTo] = useState<{ messageId: string; preview: string } | null>(null);
  const [optimistic, setOptimistic] = useState<AdminThreadMessage[]>([]);
  const [sending, setSending] = useState(false);
  const [infoPaneOpen, setInfoPaneOpen] = useState(false);

  // Registry of DOM refs by messageId, used for quoted-reply jump
  const messageRefs = useRef<Map<string, React.MutableRefObject<HTMLDivElement | null>>>(new Map());

  function getMessageRef(messageId: string): React.MutableRefObject<HTMLDivElement | null> | null {
    if (!messageRefs.current.has(messageId)) {
      messageRefs.current.set(messageId, { current: null });
    }
    return messageRefs.current.get(messageId) ?? null;
  }

  // Clear transient state when thread changes
  useEffect(() => {
    setOptimistic([]);
    setReplyTo(null);
    setInfoPaneOpen(false);
    messageRefs.current.clear();
  }, [counterparty, sessionId]);

  // Merge polled + optimistic + SSE messages, dedup by messageId
  const polledIds = useMemo(() => new Set(items.map((m) => m.messageId)), [items]);
  const deduplicatedSse = useMemo(
    () => ssePushed.filter((m) => !polledIds.has(m.messageId)),
    [ssePushed, polledIds],
  );
  const allMessages = useMemo(() => {
    const merged = [...items, ...optimistic, ...deduplicatedSse];
    if (sseStatusPatch.size === 0) return merged;
    return merged.map((m) => {
      const patched = sseStatusPatch.get(m.messageId);
      return patched !== undefined ? { ...m, status: patched } : m;
    });
  }, [items, optimistic, deduplicatedSse, sseStatusPatch]);

  // Scroll management
  const prevCounterparty = useRef<string | null>(null);
  const prevSseLenRef = useRef(0);
  const initialScrollDone = useRef(false);

  function scrollToBottom() {
    const el = scrollContainerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }

  useLayoutEffect(() => {
    const threadChanged = counterparty !== prevCounterparty.current;
    if (threadChanged) {
      prevCounterparty.current = counterparty;
      prevSseLenRef.current = 0;
      initialScrollDone.current = false;
    }
    if (!initialScrollDone.current && items.length > 0) {
      initialScrollDone.current = true;
      const handle = requestAnimationFrame(scrollToBottom);
      return () => cancelAnimationFrame(handle);
    }
    const sseArrived = deduplicatedSse.length > prevSseLenRef.current;
    prevSseLenRef.current = deduplicatedSse.length;
    if (sseArrived) scrollToBottom();
    return undefined;
  }, [counterparty, items, deduplicatedSse]);

  // Send handler, preserved from original ConversationsPanel
  async function handleSend(text: string) {
    if (!stepUpDone) {
      onStepUpRequired();
      return;
    }
    if (!sessionId || !counterparty || !text.trim()) return;
    setSending(true);

    const tempId = `opt-${Date.now()}`;
    const optimisticMsg: AdminThreadMessage = {
      messageId: tempId,
      direction: 'out',
      ts: new Date().toISOString(),
      body: { kind: 'text', text: text.trim() },
      status: 'queued',
    };
    setOptimistic((prev) => [...prev, optimisticMsg]);

    try {
      const payload: Record<string, unknown> = {
        to: counterparty,
        body: { kind: 'text', text: text.trim() },
        purpose: 'support',
      };
      if (replyTo) payload.replyTo = { messageId: replyTo.messageId };

      const res = await fetch(`/api/admin/sessions/${sessionId}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload),
      });

      if (res.status === 403) {
        setOptimistic((prev) => prev.filter((m) => m.messageId !== tempId));
        onStepUpRequired();
        toast.info('WebAuthn step-up required to send messages.');
        return;
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }

      const data = (await res.json()) as { messageId: string; status: 'queued' };
      setOptimistic((prev) =>
        prev.map((m) => (m.messageId === tempId ? { ...m, messageId: data.messageId } : m)),
      );
      setReplyTo(null);
    } catch (err) {
      setOptimistic((prev) => prev.filter((m) => m.messageId !== tempId));
      toast.error(`Send failed: ${(err as Error).message}`);
    } finally {
      setSending(false);
    }
  }

  // Empty state
  if (!counterparty) {
    return (
      <div
        className="flex h-full items-center justify-center"
        style={{ backgroundColor: 'var(--ww-pane-bg)' }}
      >
        <div className="text-center space-y-2">
          <div
            className="mx-auto flex h-20 w-20 items-center justify-center rounded-full"
            style={{ backgroundColor: 'var(--ww-row-active-bg)' }}
            aria-hidden="true"
          >
            <Users className="h-10 w-10" style={{ color: 'var(--ww-text-muted)' }} />
          </div>
          <p className="text-sm" style={{ color: 'var(--ww-text-secondary)' }}>
            Select a conversation to start messaging
          </p>
        </div>
      </div>
    );
  }

  const isGroup = counterparty.endsWith('@g.us');
  const contact = contacts.get(counterparty) ?? null;
  const displayName = contact?.displayName ?? contact?.pushName ?? counterparty;

  // Build consecutive-author groups for tail rendering
  // Each message is tagged with whether it's the first in its author run.
  const taggedMessages: Array<{ msg: AdminThreadMessage; showTail: boolean }> = [];
  for (let i = 0; i < allMessages.length; i++) {
    const msg = allMessages[i]!;
    const next = allMessages[i + 1];
    // Show tail on the LAST message in a consecutive group (the one just before
    // a different author, or the final message). This matches WW behaviour.
    const isLastInGroup = !next || next.direction !== msg.direction;
    taggedMessages.push({ msg, showTail: isLastInGroup });
  }

  return (
    /*
     * Outer: flex-row so InfoPane's aside sits as a third column to the right.
     * Inner: flex-1 min-w-0 flex-col holds the existing header/bubbles/composer
     * stack. min-w-0 prevents the centre column overflowing when InfoPane opens.
     */
    <div
      className="flex h-full flex-row overflow-hidden"
      style={{ backgroundColor: 'var(--ww-pane-bg)' }}
    >
      <div
        className="flex flex-1 min-w-0 flex-col overflow-hidden"
        style={{ backgroundColor: 'var(--ww-pane-bg)' }}
      >
        {/* Sticky header */}
        <div
          className="flex items-center gap-3 px-4 py-2.5 shrink-0"
          style={{
            backgroundColor: 'var(--ww-header-bg)',
            borderBottom: '1px solid var(--ww-border)',
          }}
        >
          <button
            type="button"
            aria-label={`Open info for ${displayName}`}
            onClick={() => setInfoPaneOpen(true)}
            className="flex items-center gap-3 flex-1 min-w-0 text-left rounded cursor-pointer focus:outline-none focus-visible:ring-1 focus-visible:ring-ring transition-colors hover:bg-[var(--ww-row-hover-bg)] px-2 -mx-2"
          >
            {isGroup ? (
              <div
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full"
                style={{ backgroundColor: '#aebac1' }}
              >
                <Users className="h-5 w-5 text-white" />
              </div>
            ) : (
              <Avatar
                e164={counterparty}
                displayName={displayName}
                profilePictureUrl={contact?.profilePictureUrl}
                size={40}
              />
            )}
            <div className="flex min-w-0 flex-col">
              <span
                className="truncate text-sm font-semibold"
                style={{ color: 'var(--ww-text-primary)' }}
              >
                {isGroup ? groupLabel(counterparty) : displayName}
              </span>
              {!isGroup && contact?.lastSeenAt ? (
                <span className="truncate text-xs" style={{ color: 'var(--ww-text-secondary)' }}>
                  last seen{' '}
                  {new Intl.DateTimeFormat('en-GB', {
                    day: 'numeric',
                    month: 'short',
                    hour: '2-digit',
                    minute: '2-digit',
                  }).format(new Date(contact.lastSeenAt))}
                </span>
              ) : (
                !isGroup && (
                  <span
                    className="font-mono truncate text-xs"
                    style={{ color: 'var(--ww-text-muted)' }}
                  >
                    {counterparty}
                  </span>
                )
              )}
            </div>
          </button>

          <button
            type="button"
            aria-label="Contact info"
            onClick={() => setInfoPaneOpen(true)}
            className="shrink-0 rounded-full p-1.5 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            style={{ color: 'var(--ww-text-muted)' }}
          >
            <Info className="h-5 w-5" />
          </button>
        </div>

        {/* ARIA live region for incoming messages */}
        <div
          role="status"
          aria-live="polite"
          aria-atomic="false"
          className="sr-only"
          aria-label="New messages"
        >
          {deduplicatedSse.length > 0 && (
            <span>
              {deduplicatedSse.length} new message{deduplicatedSse.length !== 1 ? 's' : ''}
            </span>
          )}
        </div>

        {/* Bubble list, overflow-y-auto + min-h-0 bounds the flex child */}
        <div
          ref={scrollContainerRef}
          className="flex-1 min-h-0 overflow-y-auto"
          aria-label="Messages"
        >
          <div className="flex flex-col gap-0.5 px-4 py-4">
            {/* Load older button */}
            {nextCursor && (
              <div className="flex justify-center pb-3">
                <button
                  type="button"
                  onClick={loadMore}
                  disabled={loading}
                  className="rounded-full px-3 py-1 text-xs transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
                  style={{
                    backgroundColor: 'var(--ww-day-sep-bg)',
                    color: 'var(--ww-day-sep-text)',
                  }}
                >
                  {loading ? 'Loading…' : 'Load older messages'}
                </button>
              </div>
            )}

            {allMessages.length === 0 && !loading ? (
              <p className="py-8 text-center text-xs" style={{ color: 'var(--ww-text-muted)' }}>
                No messages.
              </p>
            ) : (
              (() => {
                let lastDayKey = '';
                return taggedMessages.map(({ msg, showTail }) => {
                  const msgDate = new Date(msg.ts);
                  const dayKey = calendarKey(msgDate);
                  const showSep = dayKey !== lastDayKey;
                  lastDayKey = dayKey;

                  return (
                    <Fragment key={msg.messageId}>
                      {showSep && (
                        <div
                          className="flex items-center gap-3 py-3 px-2"
                          role="separator"
                          aria-label={dayLabel(msgDate)}
                        >
                          <div
                            className="h-px flex-1"
                            style={{ backgroundColor: 'var(--ww-border)' }}
                          />
                          <span
                            className="rounded-full px-3 py-0.5 text-[0.65rem] shrink-0"
                            style={{
                              backgroundColor: 'var(--ww-day-sep-bg)',
                              color: 'var(--ww-day-sep-text)',
                            }}
                          >
                            {dayLabel(msgDate)}
                          </span>
                          <div
                            className="h-px flex-1"
                            style={{ backgroundColor: 'var(--ww-border)' }}
                          />
                        </div>
                      )}

                      {/* Register DOM ref for quoted-reply jump */}
                      <MessageBubbleWithRef
                        message={msg}
                        showTail={showTail}
                        onReply={(id, preview) => setReplyTo({ messageId: id, preview })}
                        getMessageRef={getMessageRef}
                      />
                    </Fragment>
                  );
                });
              })()
            )}
          </div>
        </div>

        {/* Sticky composer */}
        <Composer
          stepUpDone={stepUpDone}
          sending={sending}
          replyTo={replyTo}
          onClearReply={() => setReplyTo(null)}
          onSend={handleSend}
          onStepUpRequired={onStepUpRequired}
        />
      </div>

      {/* Info pane, inline aside on desktop, Dialog on mobile */}
      <InfoPane
        open={infoPaneOpen}
        onClose={() => setInfoPaneOpen(false)}
        counterparty={counterparty}
        contact={contact}
        messages={allMessages}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// MessageBubbleWithRef, thin wrapper that attaches the DOM ref after mount
// ---------------------------------------------------------------------------

function MessageBubbleWithRef(props: Parameters<typeof MessageBubble>[0]) {
  const internalRef = useRef<HTMLDivElement | null>(null);
  const registeredRef = props.getMessageRef(
    props.message.messageId,
  ) as React.MutableRefObject<HTMLDivElement | null> | null;

  // Bridge: copy the DOM node into the registry ref on mount
  useEffect(() => {
    const el = internalRef.current;
    if (registeredRef && el) {
      registeredRef.current = el;
    }
    return () => {
      if (registeredRef) registeredRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div ref={internalRef}>
      <MessageBubble {...props} />
    </div>
  );
}

'use client';
/**
 * MessageBubble, renders a single chat message in WhatsApp Web style.
 *
 * Own messages (direction === 'out') float right with the green bubble.
 * Peer messages (direction === 'in') float left with the white/grey bubble.
 *
 * Handles:
 *   - text with URL auto-linking
 *   - image / document / audio / video / sticker media
 *   - quoted reply (left-accent bar)
 *   - reaction pills (bottom-right overlap)
 *   - status ticks for own messages
 *   - "edited" pill + revision accordion
 *   - "deleted" placeholder + revision accordion (the whole point of slice 6)
 *   - tail SVG on the first bubble in a consecutive-author group
 *
 * React.memo keyed on messageId + revisions.length, memoised to avoid
 * re-rendering the full list on parent state changes.
 */
import React, { useRef } from 'react';
import {
  Camera,
  FileText,
  Mic,
  Video,
  Trash2,
  TriangleAlert,
  Clock,
  CheckCheck,
  Check,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { AdminThreadMessage, AdminThreadMessageBody } from '../../_types';
import type { AdminThreadMessageRevision } from '@hmddevs/protocol';

// ---------------------------------------------------------------------------
// FNV-1a hash for deterministic avatar colours
// ---------------------------------------------------------------------------

function fnv1a(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    // imitate 32-bit unsigned multiplication
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash;
}

const AVATAR_COLOURS = [
  '#e17055',
  '#6c5ce7',
  '#00b894',
  '#0984e3',
  '#fd79a8',
  '#a29bfe',
  '#55efc4',
  '#fdcb6e',
];

export function avatarColour(e164: string): string {
  return AVATAR_COLOURS[fnv1a(e164) % AVATAR_COLOURS.length] ?? '#8696a0';
}

// ---------------------------------------------------------------------------
// URL auto-linker, turns bare URLs in text into <a> tags.
// No heavy markdown lib; just a simple pattern.
// ---------------------------------------------------------------------------

// Non-global: used only for split. A separate predicate avoids the
// stateful lastIndex issue of calling /g.test() inside a map.
const URL_SPLIT_RE = /(https?:\/\/[^\s<>"]+)/;
const URL_STARTS = (s: string) => s.startsWith('http://') || s.startsWith('https://');

function AutoLinkedText({ text }: { text: string }) {
  const parts = text.split(URL_SPLIT_RE);
  return (
    <>
      {parts.map((part, i) =>
        URL_STARTS(part) ? (
          <a
            key={i}
            href={part}
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2 break-all"
            style={{ color: 'inherit', opacity: 0.85 }}
          >
            {part}
          </a>
        ) : (
          <React.Fragment key={i}>{part}</React.Fragment>
        ),
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Body renderer, text, image, document, audio, video, sticker, other.
// ---------------------------------------------------------------------------

function BodyContent({ body }: { body: AdminThreadMessageBody }) {
  if (body.kind === 'text') {
    return (
      <span className="whitespace-pre-wrap break-words text-[0.875rem] leading-snug">
        <AutoLinkedText text={body.text} />
      </span>
    );
  }
  if (body.kind === 'image') {
    return (
      <div className="flex flex-col gap-1">
        <div
          className="flex h-36 w-52 items-center justify-center rounded-lg"
          style={{ backgroundColor: 'rgba(0,0,0,0.08)' }}
          aria-label="Image attachment"
        >
          <Camera className="h-10 w-10" style={{ color: 'var(--ww-text-muted)' }} />
        </div>
        {body.caption && <span className="block text-sm break-words">{body.caption}</span>}
      </div>
    );
  }
  if (body.kind === 'document') {
    return (
      <div
        className="flex items-center gap-2 rounded-lg px-3 py-2"
        style={{ backgroundColor: 'rgba(0,0,0,0.06)' }}
        aria-label="Document attachment"
      >
        <FileText className="h-5 w-5 shrink-0" style={{ color: 'var(--ww-text-muted)' }} />
        <span className="text-sm break-all">{body.mediaFileName ?? 'Document'}</span>
      </div>
    );
  }
  if (body.kind === 'audio') {
    return (
      <div className="flex items-center gap-2 px-1 py-0.5" aria-label="Audio message">
        <Mic className="h-4 w-4 shrink-0" style={{ color: 'var(--ww-text-muted)' }} />
        <span className="text-xs" style={{ color: 'var(--ww-text-secondary)' }}>
          Audio
        </span>
      </div>
    );
  }
  if (body.kind === 'video') {
    return (
      <div className="flex items-center gap-2 px-1 py-0.5" aria-label="Video message">
        <Video className="h-4 w-4 shrink-0" style={{ color: 'var(--ww-text-muted)' }} />
        <span className="text-xs" style={{ color: 'var(--ww-text-secondary)' }}>
          Video
        </span>
      </div>
    );
  }
  const labels: Record<string, string> = {
    sticker: 'Sticker',
    other: 'Attachment',
  };
  return (
    <em className="not-italic text-sm" style={{ color: 'var(--ww-text-secondary)' }}>
      {labels[body.kind] ?? 'Unknown'}
    </em>
  );
}

// ---------------------------------------------------------------------------
// Status tick renderer
// ---------------------------------------------------------------------------

function StatusTick({ status }: { status: string }) {
  if (status === 'queued' || status === 'scheduled') {
    return (
      <Clock
        className="h-3 w-3 shrink-0"
        style={{ color: 'var(--ww-tick-grey)' }}
        aria-label="Message queued"
      />
    );
  }
  if (status === 'sent') {
    return (
      <Check
        className="h-3.5 w-3.5 shrink-0"
        style={{ color: 'var(--ww-tick-grey)' }}
        aria-label="Message sent"
      />
    );
  }
  if (status === 'delivered') {
    return (
      <CheckCheck
        className="h-3.5 w-3.5 shrink-0"
        style={{ color: 'var(--ww-tick-grey)' }}
        aria-label="Message delivered"
      />
    );
  }
  if (status === 'read') {
    return (
      <CheckCheck
        className="h-3.5 w-3.5 shrink-0"
        style={{ color: 'var(--ww-tick-blue)' }}
        aria-label="Message read"
      />
    );
  }
  if (status === 'failed' || status === 'expired') {
    return (
      <TriangleAlert
        className="h-3.5 w-3.5 shrink-0"
        style={{ color: 'var(--ww-tick-fail)' }}
        aria-label={status === 'failed' ? 'Message failed' : 'Message expired'}
      />
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Revision accordion
// ---------------------------------------------------------------------------

function RevisionAccordion({
  revisions,
  originalBody,
}: {
  revisions: AdminThreadMessageRevision[];
  originalBody: AdminThreadMessageBody;
}) {
  const history: Array<{ label: string; body: AdminThreadMessageBody | undefined; ts: string }> = [
    { label: 'Original', body: originalBody, ts: '' },
    ...revisions.map((r, i) => ({
      label: r.kind === 'delete' ? `Deleted (rev ${i + 1})` : `Edited (rev ${i + 1})`,
      body: r.body,
      ts: r.ts,
    })),
  ];

  return (
    <details className="mt-2">
      <summary
        className="cursor-pointer select-none text-xs"
        style={{ color: 'var(--ww-text-muted)' }}
        aria-label="Show revision history"
      >
        Show history ({revisions.length} revision{revisions.length !== 1 ? 's' : ''})
      </summary>
      <div
        className="mt-1.5 flex flex-col gap-1.5 pl-2 border-l-2"
        style={{ borderColor: 'var(--ww-reply-bar)' }}
      >
        {history.map((entry, i) => (
          <div key={i} className="text-xs">
            <span className="font-medium" style={{ color: 'var(--ww-text-secondary)' }}>
              {entry.label}
              {entry.ts && (
                <span className="ml-1.5 font-normal" style={{ color: 'var(--ww-text-muted)' }}>
                  {formatBubbleTime(entry.ts)}
                </span>
              )}
            </span>
            {entry.body && (
              <div className="mt-0.5" style={{ color: 'var(--ww-text-primary)' }}>
                <BodyContent body={entry.body} />
              </div>
            )}
          </div>
        ))}
      </div>
    </details>
  );
}

// ---------------------------------------------------------------------------
// Time formatter helpers
// ---------------------------------------------------------------------------

const TIME_FMT = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });

function formatBubbleTime(iso: string): string {
  if (!iso) return '';
  return TIME_FMT.format(new Date(iso));
}

// ---------------------------------------------------------------------------
// Bubble tail SVG, shown on the first message in a group.
// Geometry approximates the WW tail.
// TODO: refine vs WW, eyeballed from screenshots, not pixel-matched
// ---------------------------------------------------------------------------

function OutTail() {
  return (
    <svg
      width="8"
      height="13"
      viewBox="0 0 8 13"
      className="absolute -right-[7px] bottom-0 shrink-0"
      aria-hidden="true"
    >
      <path d="M6 0 C6 0 6 8 0 13 L8 13 Z" fill="var(--ww-bubble-out-bg)" />
    </svg>
  );
}

function InTail() {
  return (
    <svg
      width="8"
      height="13"
      viewBox="0 0 8 13"
      className="absolute -left-[7px] bottom-0 shrink-0"
      aria-hidden="true"
    >
      <path d="M2 0 C2 0 2 8 8 13 L0 13 Z" fill="var(--ww-bubble-in-bg)" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// MessageBubble props
// ---------------------------------------------------------------------------

export interface MessageBubbleProps {
  message: AdminThreadMessage;
  /** True when this is the first bubble in a consecutive-author group (shows the tail). */
  showTail: boolean;
  /** Called when user clicks the bubble to set it as reply target. */
  onReply: (messageId: string, preview: string) => void;
  /** Used to scroll to the quoted original when clicking a quoted-reply preview. */
  getMessageRef: (messageId: string) => React.MutableRefObject<HTMLDivElement | null> | null;
}

// ---------------------------------------------------------------------------
// previewText, short preview string for a message body
// ---------------------------------------------------------------------------

export function previewText(body: AdminThreadMessageBody): string {
  if (body.kind === 'text') return body.text.slice(0, 60);
  if (body.kind === 'image') return body.caption ? `Photo: ${body.caption.slice(0, 50)}` : 'Photo';
  if (body.kind === 'document')
    return body.mediaFileName ? `Document: ${body.mediaFileName}` : 'Document';
  if (body.kind === 'audio') return 'Audio';
  if (body.kind === 'video') return 'Video';
  if (body.kind === 'sticker') return 'Sticker';
  return 'Attachment';
}

// ---------------------------------------------------------------------------
// The component
// ---------------------------------------------------------------------------

function MessageBubbleInner({ message, showTail, onReply, getMessageRef }: MessageBubbleProps) {
  const isOut = message.direction === 'out';
  const revisions = message.revisions ?? [];
  const latestRevision = revisions.length > 0 ? revisions[revisions.length - 1] : undefined;
  const isDeleted = latestRevision?.kind === 'delete';
  const isEdited = !isDeleted && latestRevision?.kind === 'edit';

  const bubbleRef = useRef<HTMLDivElement>(null);
  const ownRef = getMessageRef(message.messageId);
  // Assign the ref from the registry if available
  if (ownRef && bubbleRef !== ownRef) {
    // Bridge: mirror the DOM node into the caller's ref map
    // (we can't assign to ownRef.current directly from inside render cleanly,
    // so we use a callback pattern via the bubbleRef and a layout effect in
    // ConversationPane instead, see note in ConversationPane)
  }

  function handleReply(e: React.MouseEvent | React.KeyboardEvent) {
    if ('key' in e && e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    onReply(
      message.messageId,
      previewText(isDeleted ? message.body : (message.latestBody ?? message.body)),
    );
  }

  function handleQuoteClick(targetId: string) {
    const ref = getMessageRef(targetId);
    if (ref?.current) {
      ref.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  const bodyToRender = isDeleted ? message.body : (message.latestBody ?? message.body);

  return (
    <div
      id={`msg-${message.messageId}`}
      className={cn('flex', isOut ? 'justify-end' : 'justify-start')}
      data-message-id={message.messageId}
    >
      <div className={cn('group relative max-w-[75%] sm:max-w-[65%]', isOut ? 'mr-2' : 'ml-2')}>
        {/* Bubble */}
        <div
          ref={bubbleRef}
          role="button"
          tabIndex={0}
          aria-label="Click to reply to this message"
          onClick={handleReply}
          onKeyDown={(e) => handleReply(e)}
          className={cn(
            'relative rounded-lg px-3 py-2 text-sm cursor-pointer',
            'focus:outline-none focus-visible:ring-2',
            'focus-visible:ring-offset-1',
            isOut ? 'rounded-br-sm' : 'rounded-bl-sm',
          )}
          style={{
            backgroundColor: isOut ? 'var(--ww-bubble-out-bg)' : 'var(--ww-bubble-in-bg)',
            color: isOut ? 'var(--ww-bubble-out-text)' : 'var(--ww-bubble-in-text)',
          }}
        >
          {/* Tail SVG, only on first in a group */}
          {showTail && (isOut ? <OutTail /> : <InTail />)}

          {/* Quoted reply preview */}
          {message.body.kind === 'text' &&
            (message as { replyTo?: { messageId: string; preview?: string } }).replyTo && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  const rt = (message as { replyTo?: { messageId: string } }).replyTo;
                  if (rt) handleQuoteClick(rt.messageId);
                }}
                className="mb-1.5 flex w-full items-start gap-1.5 rounded border-l-4 px-2 py-1 text-left text-xs"
                style={{
                  borderColor: 'var(--ww-reply-bar)',
                  backgroundColor: 'var(--ww-reply-bg)',
                  color: 'var(--ww-text-secondary)',
                }}
                aria-label="Jump to quoted message"
              >
                <span className="line-clamp-2">
                  {(message as { replyTo?: { preview?: string } }).replyTo?.preview ?? '…'}
                </span>
              </button>
            )}

          {/* Body */}
          {isDeleted ? (
            <div
              className="flex items-center gap-1.5 italic"
              style={{ color: 'var(--ww-text-muted)' }}
            >
              <Trash2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span className="text-sm">This message was deleted</span>
            </div>
          ) : (
            <BodyContent body={bodyToRender} />
          )}

          {/* Timestamp row, only for non-deleted messages */}
          {!isDeleted && (
            <div
              className="mt-1 flex items-center justify-end gap-1 text-[0.65rem] select-none"
              style={{ color: 'var(--ww-text-muted)' }}
            >
              {isEdited && <span className="italic mr-0.5">edited</span>}
              <span className="tabular-nums">{formatBubbleTime(message.ts)}</span>
              {isOut && message.status && <StatusTick status={message.status} />}
            </div>
          )}

          {/* Deleted message: minimal timestamp without ticks */}
          {isDeleted && (
            <div
              className="mt-1 flex items-center justify-end gap-1 text-[0.65rem]"
              style={{ color: 'var(--ww-text-muted)' }}
            >
              <span className="tabular-nums">{formatBubbleTime(message.ts)}</span>
            </div>
          )}
        </div>

        {/* Revision accordion, rendered outside the clickable bubble to avoid nesting issues */}
        {revisions.length > 0 && (
          <div
            className="px-1"
            style={{ color: 'var(--ww-text-primary)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <RevisionAccordion revisions={revisions} originalBody={message.body} />
          </div>
        )}
      </div>
    </div>
  );
}

export const MessageBubble = React.memo(MessageBubbleInner, (prev, next) => {
  return (
    prev.message.messageId === next.message.messageId &&
    (prev.message.revisions?.length ?? 0) === (next.message.revisions?.length ?? 0) &&
    prev.message.status === next.message.status &&
    prev.showTail === next.showTail
  );
});

MessageBubble.displayName = 'MessageBubble';

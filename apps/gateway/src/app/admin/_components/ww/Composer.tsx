'use client';
/**
 * Composer, WhatsApp Web style message input bar.
 *
 * Visual: emoji button (placeholder), attachment button (placeholder),
 * auto-growing textarea, send button (paper-plane when text, mic when empty).
 *
 * All send wiring and step-up gate logic is preserved from the original
 * ConversationsPanel.Composer.
 */
import { useRef, useState } from 'react';
import { Smile, Paperclip, Send, Mic, X } from 'lucide-react';
import { cn } from '@/lib/utils';

interface ComposerProps {
  stepUpDone: boolean;
  sending: boolean;
  replyTo: { messageId: string; preview: string } | null;
  onClearReply: () => void;
  onSend: (text: string) => void;
  onStepUpRequired: () => void;
}

export function Composer({
  stepUpDone,
  sending,
  replyTo,
  onClearReply,
  onSend,
  onStepUpRequired,
}: ComposerProps) {
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const stepUpRequired = !stepUpDone;
  const hasText = text.trim().length > 0;

  function submit() {
    if (!stepUpDone) {
      onStepUpRequired();
      return;
    }
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    onSend(trimmed);
    setText('');
    inputRef.current?.focus();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  function handleFocus() {
    if (!stepUpDone) {
      onStepUpRequired();
      inputRef.current?.blur();
    }
  }

  return (
    <div
      className="shrink-0 px-3 py-2 space-y-1.5"
      style={{ backgroundColor: 'var(--ww-composer-bg)' }}
    >
      {/* Step-up warning */}
      {stepUpRequired && (
        <div className="rounded-md px-3 py-1.5 text-xs flex items-center gap-2 bg-amber-50 border border-amber-200 dark:bg-amber-950/30 dark:border-amber-800">
          <span className="flex-1 text-amber-700 dark:text-amber-400">
            Passkey verification required to send messages.
          </span>
          <button
            type="button"
            onClick={onStepUpRequired}
            className="underline underline-offset-2 text-amber-600 hover:text-amber-500 dark:text-amber-400 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            Verify now
          </button>
        </div>
      )}

      {/* Quoted reply preview */}
      {replyTo && (
        <div
          className="flex items-center gap-2 rounded-md px-3 py-1.5 text-xs"
          style={{
            backgroundColor: 'var(--ww-reply-bg)',
            borderLeft: '3px solid var(--ww-reply-bar)',
          }}
        >
          <span className="flex-1 truncate" style={{ color: 'var(--ww-text-secondary)' }}>
            Replying to: <span style={{ color: 'var(--ww-text-primary)' }}>{replyTo.preview}</span>
          </span>
          <button
            type="button"
            aria-label="Clear reply"
            onClick={onClearReply}
            className="shrink-0 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded"
            style={{ color: 'var(--ww-text-muted)' }}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Input row */}
      <div className="flex items-end gap-2">
        {/* Emoji button, placeholder */}
        <button
          type="button"
          aria-label="Emoji (not yet available)"
          className="shrink-0 rounded-full p-1.5 transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          style={{ color: 'var(--ww-text-muted)' }}
          tabIndex={0}
          // No emoji picker in this slice, placeholder only
          onClick={() => {
            /* TODO: emoji picker */
          }}
        >
          <Smile className="h-5 w-5" />
        </button>

        {/* Attachment button, placeholder */}
        <button
          type="button"
          aria-label="Attach file (not yet available)"
          className="shrink-0 rounded-full p-1.5 transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          style={{ color: 'var(--ww-text-muted)' }}
          tabIndex={0}
          onClick={() => {
            /* TODO: attachment upload */
          }}
        >
          <Paperclip className="h-5 w-5" />
        </button>

        {/* Auto-growing textarea */}
        <textarea
          ref={inputRef}
          value={text}
          onChange={(e) => {
            if (!stepUpRequired) setText(e.target.value);
          }}
          onKeyDown={handleKeyDown}
          onFocus={handleFocus}
          placeholder={stepUpRequired ? 'Step-up required to send' : 'Type a message'}
          disabled={sending}
          aria-disabled={stepUpRequired || sending}
          rows={1}
          className={cn(
            'flex-1 resize-none rounded-lg border-0 px-3 py-2 text-sm outline-none',
            'placeholder:text-[var(--ww-text-muted)]',
            'max-h-[8rem] overflow-y-auto',
            'focus:ring-0',
            (stepUpRequired || sending) && 'opacity-50',
            stepUpRequired && 'cursor-pointer',
          )}
          style={
            {
              backgroundColor: 'var(--ww-rail-bg)',
              color: 'var(--ww-text-primary)',
              fieldSizing: 'content',
            } as React.CSSProperties
          }
        />

        {/* Send / Mic button */}
        <button
          type="button"
          onClick={submit}
          disabled={sending || (!stepUpRequired && !hasText)}
          aria-label={hasText ? 'Send message' : 'Voice note (not yet available)'}
          className={cn(
            'shrink-0 rounded-full p-2.5 transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-ring',
            'disabled:opacity-40',
          )}
          style={{
            backgroundColor: 'var(--ww-green)',
            color: '#ffffff',
          }}
        >
          {sending ? (
            <span
              className="block h-5 w-5 rounded-full border-2 border-white border-t-transparent animate-spin"
              aria-label="Sending"
            />
          ) : hasText ? (
            <Send className="h-5 w-5" />
          ) : (
            <Mic className="h-5 w-5" />
          )}
        </button>
      </div>
    </div>
  );
}

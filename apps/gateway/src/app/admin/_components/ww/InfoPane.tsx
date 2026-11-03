'use client';
/**
 * InfoPane, right slide-in panel with contact details.
 *
 * Sections:
 *   - Hero: large avatar, display name, e164
 *   - Encryption notice (Atlas at-rest AES-256, NOT end-to-end encrypted)
 *   - Business badge
 *   - Last seen
 *   - Shared media gallery (images from the message thread)
 *   - Starred messages placeholder
 *
 * On desktop (≥1024px): rendered as an inline <aside> that slides in from the
 * right edge of ConversationPane via a CSS width transition.
 * On mobile (<1024px): rendered as a Dialog modal (acceptable fidelity gap; a
 * true third-pane stack for mobile is out of scope here).
 *
 * Opens when the user clicks the top-bar avatar or info icon in ConversationPane.
 */
import { X, Lock, Briefcase, Image as ImageIcon, ChevronLeft } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Avatar } from './ThreadRail';
import type { AdminThreadMessage } from '../../_types';
import type { ContactEntry } from './ThreadRail';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FMT_LAST_SEEN = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

function fmtLastSeen(iso: string): string {
  return FMT_LAST_SEEN.format(new Date(iso));
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface InfoPaneProps {
  open: boolean;
  onClose: () => void;
  counterparty: string;
  contact: ContactEntry | null;
  /** All messages in the thread, used to build the shared media gallery. */
  messages: AdminThreadMessage[];
}

// ---------------------------------------------------------------------------
// InfoPaneBody, shared content, rendered in both the aside and the Dialog.
// ---------------------------------------------------------------------------

interface InfoPaneBodyProps {
  onClose: () => void;
  /** When true, renders a left-chevron back button instead of an X. Used on mobile. */
  mobileBack?: boolean;
  counterparty: string;
  contact: ContactEntry | null;
  messages: AdminThreadMessage[];
}

function InfoPaneBody({
  onClose,
  mobileBack = false,
  counterparty,
  contact,
  messages,
}: InfoPaneBodyProps) {
  const displayName = contact?.displayName ?? contact?.pushName ?? counterparty;
  const isGroup = counterparty.endsWith('@g.us');

  // Collect image messages for the gallery (up to 12 most recent)
  const mediaMessages = messages.filter((m) => m.body.kind === 'image').slice(-12);

  return (
    <>
      {/* Header row */}
      <div
        className="flex items-center gap-3 px-4 py-3 shrink-0"
        style={{
          backgroundColor: 'var(--ww-header-bg)',
          borderBottom: '1px solid var(--ww-border)',
        }}
      >
        <button
          type="button"
          aria-label="Close contact info"
          onClick={onClose}
          className="rounded-full p-1 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          style={{ color: 'var(--ww-text-muted)' }}
        >
          {mobileBack ? <ChevronLeft className="h-5 w-5" /> : <X className="h-5 w-5" />}
        </button>
        <span className="text-sm font-medium" style={{ color: 'var(--ww-text-primary)' }}>
          Contact info
        </span>
      </div>

      {/* Scrollable body */}
      <div className="overflow-y-auto flex-1">
        {/* Hero section */}
        <div
          className="flex flex-col items-center gap-3 px-6 py-6"
          style={{ backgroundColor: 'var(--ww-pane-bg)' }}
        >
          <Avatar
            e164={isGroup ? counterparty : counterparty}
            displayName={displayName}
            profilePictureUrl={contact?.profilePictureUrl}
            size={96}
          />
          <div className="text-center">
            <p className="text-base font-semibold" style={{ color: 'var(--ww-text-primary)' }}>
              {displayName}
            </p>
            {!isGroup && (
              <p className="mt-0.5 font-mono text-sm" style={{ color: 'var(--ww-text-secondary)' }}>
                {counterparty}
              </p>
            )}
          </div>
        </div>

        {/* Metadata section */}
        <div className="divide-y" style={{ borderColor: 'var(--ww-border)' }}>
          {/* Business badge */}
          {contact?.isBusiness && (
            <div className="flex items-center gap-3 px-4 py-3">
              <Briefcase className="h-4 w-4 shrink-0" style={{ color: 'var(--ww-green)' }} />
              <span className="text-sm" style={{ color: 'var(--ww-text-primary)' }}>
                WhatsApp Business
              </span>
            </div>
          )}

          {/* Last seen */}
          {contact?.lastSeenAt && (
            <div className="px-4 py-3">
              <p
                className="text-xs font-medium uppercase tracking-wide mb-0.5"
                style={{ color: 'var(--ww-text-muted)' }}
              >
                Last seen
              </p>
              <p className="text-sm" style={{ color: 'var(--ww-text-primary)' }}>
                {fmtLastSeen(contact.lastSeenAt)}
              </p>
            </div>
          )}

          {/* Encryption notice, "at rest", NOT "end-to-end" */}
          <div className="flex items-start gap-3 px-4 py-3">
            <Lock className="h-4 w-4 mt-0.5 shrink-0" style={{ color: 'var(--ww-text-muted)' }} />
            <p className="text-xs" style={{ color: 'var(--ww-text-secondary)' }}>
              Stored encrypted at rest (AES-256). Messages are held in plaintext by this server.
            </p>
          </div>

          {/* Shared media */}
          <div className="px-4 py-3">
            <p
              className="text-xs font-medium uppercase tracking-wide mb-2"
              style={{ color: 'var(--ww-text-muted)' }}
            >
              Shared media
            </p>
            {mediaMessages.length === 0 ? (
              <p className="text-xs" style={{ color: 'var(--ww-text-muted)' }}>
                No shared media.
              </p>
            ) : (
              <div className="grid grid-cols-3 gap-1">
                {mediaMessages.map((msg) => (
                  <button
                    key={msg.messageId}
                    type="button"
                    aria-label="Open media"
                    className="aspect-square rounded overflow-hidden focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    style={{ backgroundColor: 'rgba(0,0,0,0.06)' }}
                  >
                    <div className="flex h-full items-center justify-center">
                      <ImageIcon className="h-6 w-6" style={{ color: 'var(--ww-text-muted)' }} />
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Starred messages, placeholder */}
          <div className="px-4 py-3">
            <p
              className="text-xs font-medium uppercase tracking-wide mb-1"
              style={{ color: 'var(--ww-text-muted)' }}
            >
              Starred messages
            </p>
            <p className="text-xs" style={{ color: 'var(--ww-text-muted)' }}>
              No starred messages yet.
            </p>
          </div>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// InfoPane, desktop aside + mobile Dialog, driven by the same open boolean.
// ---------------------------------------------------------------------------

export function InfoPane({ open, onClose, counterparty, contact, messages }: InfoPaneProps) {
  const sharedProps = { onClose, counterparty, contact, messages };

  return (
    <>
      {/*
       * Desktop (≥1024px): inline aside that slides in from the right.
       * Width transitions from 0 → 360px with a CSS transition.
       * overflow-hidden on the wrapper + fixed w-[360px] on the inner div
       * prevents content reflow during the animation.
       */}
      <aside
        aria-label="Contact info"
        className="hidden lg:flex flex-col h-full overflow-hidden shrink-0"
        style={{
          width: open ? '360px' : '0px',
          transition: 'width 250ms ease-out',
          backgroundColor: 'var(--ww-pane-bg)',
          borderLeft: open ? '1px solid var(--ww-border)' : 'none',
          boxShadow: open ? '-2px 0 4px rgba(0,0,0,0.04)' : 'none',
        }}
      >
        {/* Inner div holds fixed width so content doesn't reflow during transition */}
        <div className="flex flex-col h-full w-[360px]">
          <InfoPaneBody {...sharedProps} />
        </div>
      </aside>

      {/*
       * Mobile (<1024px): Dialog modal.
       * A true single-pane slide-in for mobile is deferred, the brief
       * explicitly permits this approach for the mobile path.
       */}
      <Dialog
        open={open}
        onOpenChange={(v) => {
          if (!v) onClose();
        }}
      >
        <DialogContent
          className="lg:hidden sm:max-w-sm p-0 overflow-hidden flex flex-col"
          style={{
            backgroundColor: 'var(--ww-pane-bg)',
            color: 'var(--ww-text-primary)',
            maxHeight: '90vh',
          }}
        >
          <DialogHeader className="sr-only">
            <DialogTitle>Contact info</DialogTitle>
          </DialogHeader>
          <InfoPaneBody {...sharedProps} mobileBack />
        </DialogContent>
      </Dialog>
    </>
  );
}

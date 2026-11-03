'use client';
/**
 * ThreadRail, left-column thread list.
 *
 * Each row: round avatar (profile picture or initials), display name,
 * last-message preview, right-aligned timestamp + unread bubble.
 *
 * Preserves from old panel:
 *   - IntersectionObserver-driven load-more
 *   - debounced search (wired externally, 250 ms)
 *   - group thread label and icon
 *   - new conversation button
 */
import React, { useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import { Search, Users, SquarePen } from 'lucide-react';
import { cn } from '@/lib/utils';
import { avatarColour } from './MessageBubble';
import type { AdminThreadSummary, AdminThreadMessageBody } from '../../_types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Display label for a group JID: "Group ···XXXXXXXX" (last 8 digits). */
export function groupLabel(jid: string): string {
  const digits = jid.replace('@g.us', '');
  return `Group ${digits.slice(-8)}`;
}

function railTimestamp(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / 86_400_000);

  if (diffDays === 0) {
    return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' }).format(date);
  }
  if (diffDays < 7) {
    return new Intl.DateTimeFormat('en-GB', { weekday: 'short' }).format(date);
  }
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
  }).format(date);
}

function mediaPreview(body: AdminThreadMessageBody): string {
  if (body.kind === 'text') return body.text.slice(0, 80);
  if (body.kind === 'image')
    return body.caption ? `\u{1F4F7} ${body.caption.slice(0, 40)}` : '\u{1F4F7} Photo';
  if (body.kind === 'document')
    return body.mediaFileName ? `\u{1F4CE} ${body.mediaFileName}` : '\u{1F4CE} Document';
  if (body.kind === 'audio') return '\u{1F3A4} Audio';
  if (body.kind === 'video') return '\u{1F4F9} Video';
  if (body.kind === 'sticker') return 'Sticker';
  return 'Attachment';
}

// ---------------------------------------------------------------------------
// InitialsAvatar + ProfileImage helpers
// ---------------------------------------------------------------------------

function InitialsAvatar({ initials, bg, size }: { initials: string; bg: string; size: number }) {
  return (
    <div
      className="rounded-full shrink-0 flex items-center justify-center text-white font-semibold"
      style={{ width: size, height: size, backgroundColor: bg, fontSize: size * 0.35 }}
    >
      {initials}
    </div>
  );
}

function ProfileImage({
  src,
  alt,
  size,
  fallback,
}: {
  src: string;
  alt: string;
  size: number;
  fallback: React.ReactNode;
}) {
  const [errored, setErrored] = useState(false);
  if (errored) return <>{fallback}</>;
  return (
    <Image
      src={src}
      alt={alt}
      width={size}
      height={size}
      className="rounded-full object-cover shrink-0"
      style={{ width: size, height: size }}
      onError={() => setErrored(true)}
      unoptimized
    />
  );
}

// ---------------------------------------------------------------------------
// Avatar
// ---------------------------------------------------------------------------

interface AvatarProps {
  e164: string;
  displayName: string;
  profilePictureUrl?: string;
  size?: number;
}

function Avatar({ e164, displayName, profilePictureUrl, size = 48 }: AvatarProps) {
  const initials = displayName
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
  const bg = avatarColour(e164);

  if (profilePictureUrl) {
    return (
      <ProfileImage
        src={profilePictureUrl}
        alt={`${displayName} avatar`}
        size={size}
        fallback={<InitialsAvatar initials={initials || e164.slice(-2)} bg={bg} size={size} />}
      />
    );
  }

  return (
    <div
      className="rounded-full shrink-0 flex items-center justify-center text-white font-semibold"
      style={{ width: size, height: size, backgroundColor: bg, fontSize: size * 0.35 }}
      aria-label={`${displayName} avatar`}
    >
      {initials || e164.slice(-2)}
    </div>
  );
}

export { Avatar };

// ---------------------------------------------------------------------------
// ThreadRail props
// ---------------------------------------------------------------------------

export interface ContactEntry {
  e164: string;
  displayName?: string;
  pushName?: string;
  profilePictureUrl?: string;
  isBusiness?: boolean;
  lastSeenAt?: string;
}

interface ThreadRailProps {
  items: AdminThreadSummary[];
  nextCursor: string | null;
  loading: boolean;
  loadMore: () => void;
  search: string;
  onSearchChange: (v: string) => void;
  selectedCounterparty: string | null;
  onSelect: (cp: string) => void;
  onNewConversation?: () => void;
  /** Resolved contact info keyed by e164. Falls back to initials if absent. */
  contacts: Map<string, ContactEntry>;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ThreadRail({
  items,
  nextCursor,
  loading,
  loadMore,
  search,
  onSearchChange,
  selectedCounterparty,
  onSelect,
  onNewConversation,
  contacts,
}: ThreadRailProps) {
  const sentinelRef = useRef<HTMLDivElement>(null);

  // IntersectionObserver for infinite scroll
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) loadMore();
      },
      { rootMargin: '200px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [loadMore]);

  const isEmpty = !loading && items.length === 0;
  const isSearchEmpty = isEmpty && search.trim().length >= 2;

  return (
    <div
      className="flex h-full flex-col overflow-hidden"
      style={{ borderRight: '1px solid var(--ww-border)', backgroundColor: 'var(--ww-rail-bg)' }}
    >
      {/* Search bar + new conversation button */}
      <div
        className="flex items-center gap-1.5 px-3 py-2 shrink-0"
        style={{
          backgroundColor: 'var(--ww-header-bg)',
          borderBottom: '1px solid var(--ww-border)',
        }}
      >
        <div className="relative flex-1">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2"
            style={{ color: 'var(--ww-text-muted)' }}
            aria-hidden="true"
          />
          <input
            type="search"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search or start new chat"
            aria-label="Search conversations"
            className="w-full rounded-lg py-1.5 pl-8 pr-3 text-sm outline-none focus:ring-1 focus:ring-[var(--ww-green)]"
            style={{
              backgroundColor: 'var(--ww-rail-bg)',
              color: 'var(--ww-text-primary)',
              border: 'none',
            }}
          />
        </div>
        {onNewConversation && (
          <button
            type="button"
            aria-label="New conversation"
            title="New conversation"
            onClick={onNewConversation}
            className="shrink-0 rounded-full p-1.5 transition-colors hover:bg-black/5 dark:hover:bg-white/10 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            style={{ color: 'var(--ww-text-muted)' }}
          >
            <SquarePen className="h-4.5 w-4.5" />
          </button>
        )}
      </div>

      {/* Thread list, min-h-0 required for flex child scroll */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {isEmpty ? (
          <p className="px-4 py-8 text-center text-xs" style={{ color: 'var(--ww-text-muted)' }}>
            {isSearchEmpty ? 'No matches.' : 'No conversations yet.'}
          </p>
        ) : (
          <>
            {items.map((thread) => {
              const isGroup = thread.type === 'group';
              const cp = thread.counterparty;
              const contact = contacts.get(cp);
              const name = contact?.displayName ?? contact?.pushName ?? cp;
              const profilePic = contact?.profilePictureUrl;
              const isActive = selectedCounterparty === cp;

              return (
                <button
                  key={cp}
                  type="button"
                  onClick={() => onSelect(cp)}
                  className={cn(
                    'flex w-full items-center gap-3 px-3 py-3 text-left transition-colors',
                    'focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--ww-green)]',
                  )}
                  style={{
                    backgroundColor: isActive ? 'var(--ww-row-active-bg)' : undefined,
                  }}
                  onMouseEnter={(e) => {
                    if (!isActive)
                      (e.currentTarget as HTMLElement).style.backgroundColor =
                        'var(--ww-row-hover-bg)';
                  }}
                  onMouseLeave={(e) => {
                    if (!isActive) (e.currentTarget as HTMLElement).style.backgroundColor = '';
                  }}
                >
                  {/* Avatar */}
                  {isGroup ? (
                    <div
                      className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full"
                      style={{ backgroundColor: '#aebac1' }}
                      aria-label="Group conversation"
                    >
                      <Users className="h-6 w-6 text-white" />
                    </div>
                  ) : (
                    <Avatar e164={cp} displayName={name} profilePictureUrl={profilePic} size={48} />
                  )}

                  {/* Text content */}
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <div className="flex items-center justify-between gap-2">
                      <span
                        className={cn(
                          'truncate text-sm font-medium',
                          isGroup && 'flex items-center gap-1',
                        )}
                        style={{ color: 'var(--ww-text-primary)' }}
                      >
                        {isGroup ? groupLabel(cp) : name}
                      </span>
                      <span
                        className="shrink-0 text-[0.65rem] tabular-nums"
                        style={{ color: isActive ? 'var(--ww-green)' : 'var(--ww-text-muted)' }}
                      >
                        {railTimestamp(thread.lastMessageAt)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span
                        className="min-w-0 truncate text-xs"
                        style={{ color: 'var(--ww-text-secondary)' }}
                      >
                        {thread.lastMessagePreview ? thread.lastMessagePreview : ' '}
                      </span>
                      {thread.unreadCount > 0 && (
                        <span
                          className="shrink-0 rounded-full px-1.5 py-0.5 text-[0.6rem] font-semibold tabular-nums text-white"
                          style={{ backgroundColor: 'var(--ww-green)' }}
                          aria-label={`${thread.unreadCount} unread`}
                        >
                          {thread.unreadCount}
                        </span>
                      )}
                    </div>
                  </div>
                </button>
              );
            })}

            {/* IntersectionObserver sentinel */}
            {nextCursor && <div ref={sentinelRef} className="h-1" aria-hidden="true" />}

            {loading && (
              <p
                className="px-4 py-2 text-center text-xs"
                style={{ color: 'var(--ww-text-muted)' }}
              >
                Loading…
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

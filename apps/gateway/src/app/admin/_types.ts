/**
 * Shared types for the admin dashboard client surface.
 *
 * Mirrors `SessionDoc` from the protocol but with Date fields serialised to
 * ISO strings, since Next.js cannot pass Date across the server/client
 * boundary.
 */

export interface PairingSnapshot {
  event: 'qr' | 'paired' | 'logged_out';
  qr?: string;
  at: string;
}

export interface SessionConversationSnapshot {
  /** When true (default), the worker marks inbound messages as read. */
  sendReadReceipts: boolean;
}

export interface SessionSnapshot {
  sessionId: string;
  workerId: string;
  label: string;
  status: 'initialising' | 'pairing' | 'connected' | 'degraded' | 'offline' | 'stopped';
  phoneE164: string | null;
  pairing: PairingSnapshot | null;
  version: string | null;
  lastHeartbeatAt: string | null;
  connectedAt: string | null;
  createdBy: string;
  createdAt: string;
  stoppedAt: string | null;
  conversation?: SessionConversationSnapshot;
  /** Pre-pair history-sync progress from the most recent heartbeat.
   *  Null or absent means no sync in progress or sync complete. */
  historySyncProgress?: { received: number; isLatest: boolean } | null;
  /** Admin kill-switch, the router skips a paused session; absent means false. */
  paused?: boolean;
  /** Per-number send caps. Absent means the router's conservative defaults. */
  budget?: { perMinute: number; perHour: number; perDay: number };
}

export const ALL_SCOPES = [
  'send:notification',
  'send:transactional',
  'send:internal',
  'send:new_recipients',
  'read:status',
  'read:groups',
] as const;

export type Scope = (typeof ALL_SCOPES)[number];

export interface CreatedKey {
  keyId: string;
  plaintext: string;
  label: string;
  scopes: Scope[];
  env: 'test' | 'live';
  division: string;
  projectId: string;
  sessionId: string;
}

export interface ApiKeyView {
  keyId: string;
  label: string;
  division: string;
  projectId: string;
  env: 'test' | 'live';
  scopes: Scope[];
  rateLimitPerMin: number;
  quotaPerDay: number | null;
  sessionId: string;
  ipAllowlist?: string[];
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export const SESSION_ID_RE = /^[a-z0-9-]{2,32}$/;

/** Mirrors `ProjectIdSchema` from `@hmddevs/protocol`, kept as a plain regex
 *  so we don't pull Zod into the client bundle just for one validation. */
export const PROJECT_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/** Maps session status to a Tailwind text-colour token. */
export const STATUS_TEXT: Record<SessionSnapshot['status'], string> = {
  connected: 'text-emerald-500',
  pairing: 'text-amber-500',
  degraded: 'text-orange-500',
  offline: 'text-destructive',
  stopped: 'text-destructive',
  initialising: 'text-muted-foreground',
};

/** Maps session status to a Tailwind background-dot colour. */
export const STATUS_DOT: Record<SessionSnapshot['status'], string> = {
  connected: 'bg-emerald-500',
  pairing: 'bg-amber-500',
  degraded: 'bg-orange-500',
  offline: 'bg-destructive',
  stopped: 'bg-destructive',
  initialising: 'bg-muted-foreground',
};

export const STATUS_LABEL: Record<SessionSnapshot['status'], string> = {
  connected: 'Connected',
  pairing: 'Pairing',
  degraded: 'Degraded',
  offline: 'Offline',
  stopped: 'Stopped',
  initialising: 'Initialising',
};

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Organizations: the unit an API key binds to. Owns member sessions; the
// router picks which one sends. Replaces session pools, see
// docs/ORGANIZATIONS.md.
// ---------------------------------------------------------------------------

export const ORG_ID_RE = /^[a-z0-9-]{2,32}$/;

export type OrgStrategy = 'weighted' | 'priority' | 'round-robin';

export interface OrganizationView {
  orgId: string;
  label: string;
  sessions: string[];
  strategy: OrgStrategy;
  createdAt: string;
}

/** A reusable, organization-scoped pairing link: one link pairs up to
 *  `maxSessions` numbers. */
export type PairingInviteStatus = 'active' | 'expired' | 'revoked';

export interface PairingInviteView {
  inviteId: string;
  orgId: string;
  workerId: string;
  label?: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  status: PairingInviteStatus;
  maxSessions: number;
  sessionIds: string[];
}

export interface CreatedPairingInvite {
  url: string;
  expiresAt: string;
  inviteId: string;
  maxSessions: number;
}

export const PAIRING_STATUS_DOT: Record<PairingInviteStatus, string> = {
  active: 'bg-emerald-500',
  expired: 'bg-muted-foreground',
  revoked: 'bg-destructive',
};

export const PAIRING_STATUS_LABEL: Record<PairingInviteStatus, string> = {
  active: 'Active',
  expired: 'Expired',
  revoked: 'Revoked',
};

export interface OptOutView {
  phone: string;
  source: 'keyword' | 'admin';
  keyword?: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Conversation viewer types, re-exported from protocol to avoid drift.
// ---------------------------------------------------------------------------

export type {
  AdminThreadSummary,
  AdminThreadMessage,
  AdminMessageStatus,
  AdminThreadDirection,
  AdminThreadMessageBody,
  AdminSessionMetrics,
} from '@hmddevs/protocol';

export function fmtDate(iso: string | null): string {
  if (!iso) return ', ';
  return new Date(iso).toLocaleString('en-GB');
}

export function timeAgo(iso: string | null): string {
  if (!iso) return ', ';
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

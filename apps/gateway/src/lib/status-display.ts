/**
 * Shared PRESENTATION helpers for the public service-status surfaces (the state
 * vocabulary: labels, colours, overall message). Client-safe: no Mongo, no
 * server-only imports, no self-fetch. The data comes from the server-only
 * `@/lib/status-service` (`readPublicStatus`), which each surface calls
 * directly, so there is no fragile HTTP self-fetch to break.
 */
export type WhatsAppState = 'operational' | 'degraded' | 'down';

export interface StatusPayload {
  ok: boolean;
  whatsapp: WhatsAppState;
  checkedAt: string;
}

/**
 * Collapse the payload to a single overall state. A missing payload or an
 * unreachable gateway (`ok !== true`) is treated as down.
 */
export function overallState(data: StatusPayload | null): WhatsAppState {
  if (!data || data.ok !== true) return 'down';
  return data.whatsapp;
}

export const STATE_LABEL: Record<WhatsAppState, string> = {
  operational: 'Operational',
  degraded: 'Degraded',
  down: 'Down',
};

/** One-line summary for a banner or card headline. */
export const STATE_MESSAGE: Record<WhatsAppState, string> = {
  operational: 'All systems operational',
  degraded: 'Partial disruption detected',
  down: 'Service unavailable',
};

export const STATE_DOT: Record<WhatsAppState, string> = {
  operational: 'bg-green-500',
  degraded: 'bg-amber-400',
  down: 'bg-red-500',
};

export const STATE_TEXT: Record<WhatsAppState, string> = {
  operational: 'text-green-700 dark:text-green-400',
  degraded: 'text-amber-700 dark:text-amber-400',
  down: 'text-red-700 dark:text-red-400',
};

export const STATE_BADGE: Record<WhatsAppState, string> = {
  operational:
    'border-green-200 bg-green-50 text-green-800 dark:border-green-800 dark:bg-green-950 dark:text-green-300',
  degraded:
    'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300',
  down: 'border-red-200 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-300',
};

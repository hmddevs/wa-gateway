/**
 * Server-only data source for the public service-status surfaces.
 *
 * Single source of truth shared by GET /api/status, the /status page, and the
 * homepage status card. Callers invoke `readPublicStatus()` DIRECTLY (no HTTP
 * self-fetch), which removes the fragile base-URL dependency that previously
 * made the /status page paint "down" whenever its localhost self-fetch failed.
 *
 * SECURITY: derives only a coarse WhatsApp state from a strict worker_state
 * projection (status + lastHeartbeatAt). No phone numbers, session/worker ids,
 * counts, or error strings ever enter scope. Result is cached in-process for
 * 15 s so a public hammer cannot drive Mongo load; on any error we serve 'down'.
 */
import 'server-only';
import { col } from '@/lib/mongo';
import { deriveLiveness } from '@/app/admin/_lib/liveness';
import { logger } from '@/lib/logger';
import type { WhatsAppState, StatusPayload } from '@/lib/status-display';

interface HeartbeatSlice {
  status: string;
  lastHeartbeatAt?: Date | null;
}

let cache: { whatsapp: WhatsAppState; resolvedAt: number } | null = null;
const CACHE_TTL_MS = 15_000;

/**
 * Read ONLY status + lastHeartbeatAt from worker_state and collapse to a coarse
 * connection state. Every sensitive field is projected away at the DB.
 */
async function resolveWhatsAppState(): Promise<WhatsAppState> {
  const c = await col<HeartbeatSlice>('worker_state');
  const docs = await c
    .find({}, { projection: { _id: 0, status: 1, lastHeartbeatAt: 1 } })
    .toArray();

  if (docs.length === 0) return 'down';

  let anyStale = false;
  for (const doc of docs) {
    const hbAt = doc.lastHeartbeatAt ? doc.lastHeartbeatAt.toISOString() : null;
    const liveness = deriveLiveness(hbAt);
    if (liveness === 'online' && doc.status === 'connected') return 'operational';
    if (liveness === 'stale' || (liveness === 'online' && doc.status !== 'connected')) {
      anyStale = true;
    }
  }
  return anyStale ? 'degraded' : 'down';
}

/**
 * The public status payload. `ok` is always true here: if this code is running,
 * the gateway is up. WhatsApp state is cached for 15 s and degrades to 'down'
 * on any Mongo error rather than throwing.
 */
export async function readPublicStatus(): Promise<StatusPayload> {
  const now = Date.now();
  if (cache && now - cache.resolvedAt < CACHE_TTL_MS) {
    return { ok: true, whatsapp: cache.whatsapp, checkedAt: new Date(now).toISOString() };
  }

  let whatsapp: WhatsAppState = 'down';
  try {
    whatsapp = await resolveWhatsAppState();
  } catch (err: unknown) {
    logger.warn(
      { err: (err as Error).message, op: 'public.status' },
      'status check failed; returning down',
    );
    whatsapp = 'down';
  }

  cache = { whatsapp, resolvedAt: now };
  return { ok: true, whatsapp, checkedAt: new Date(now).toISOString() };
}

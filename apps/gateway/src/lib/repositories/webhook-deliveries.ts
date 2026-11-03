/**
 * Webhook delivery queue (durable in MongoDB; cron-driven).
 *
 * Each delivery is a single (route, event) pair. On creation, status is
 * `pending` with `nextAttemptAt = now`. The cron deliverer claims due
 * deliveries, POSTs them, and either marks them `sent`, schedules the next
 * retry (`failed` then back to `pending`), or marks `abandoned` once the
 * retry budget is exhausted.
 *
 * The `payload` column stores the canonical-JSON bytes of the WebhookEvent
 *, these are the EXACT bytes signed and POSTed (so a retry produces an
 * identical body and the consumer's idempotency story holds).
 */
import 'server-only';
import { randomUUID } from 'node:crypto';
import type { ObjectId } from 'mongodb';
import type { WebhookEventType } from '@hmddevs/protocol';
import { WEBHOOK_DELIVERY_RETRY_DELAYS_SEC, WEBHOOK_MAX_ATTEMPTS } from '@hmddevs/protocol';
import { col } from '../mongo';

export type WebhookDeliveryStatus = 'pending' | 'sent' | 'failed' | 'abandoned';

export interface WebhookDeliveryDoc {
  _id?: ObjectId;
  deliveryId: string;
  routeId: string;
  eventId: string;
  eventType: WebhookEventType;
  payload: string; // canonical JSON of the WebhookEvent
  url: string;
  status: WebhookDeliveryStatus;
  attempts: number;
  nextAttemptAt: Date | null;
  lastAttemptAt: Date | null;
  lastResponseStatus: number | null;
  lastError: string | null;
  createdAt: Date;
  expiresAt: Date;
}

const TTL_DAYS = 14;

async function ensureIndexesOnce(): Promise<void> {
  const c = await col<WebhookDeliveryDoc>('webhook_deliveries');
  await c.createIndexes([
    { key: { deliveryId: 1 }, unique: true, name: 'deliveryId_unique' },
    { key: { routeId: 1, createdAt: -1 }, name: 'route_createdAt' },
    { key: { eventId: 1 }, name: 'eventId' },
    { key: { status: 1, nextAttemptAt: 1 }, name: 'status_next' },
    // TTL: drop after 14 days regardless of status.
    { key: { expiresAt: 1 }, expireAfterSeconds: 0, name: 'ttl_expires' },
  ]);
}

export interface EnqueueDeliveryInput {
  routeId: string;
  eventId: string;
  eventType: WebhookEventType;
  payload: string;
  url: string;
}

export async function enqueueDelivery(input: EnqueueDeliveryInput): Promise<WebhookDeliveryDoc> {
  await ensureIndexesOnce();
  const c = await col<WebhookDeliveryDoc>('webhook_deliveries');
  const now = new Date();
  const doc: WebhookDeliveryDoc = {
    deliveryId: randomUUID(),
    routeId: input.routeId,
    eventId: input.eventId,
    eventType: input.eventType,
    payload: input.payload,
    url: input.url,
    status: 'pending',
    attempts: 0,
    nextAttemptAt: now,
    lastAttemptAt: null,
    lastResponseStatus: null,
    lastError: null,
    createdAt: now,
    expiresAt: new Date(now.getTime() + TTL_DAYS * 24 * 60 * 60 * 1_000),
  };
  await c.insertOne(doc);
  return doc;
}

/**
 * Claim a batch of deliveries that are due. Simple read-then-write, the
 * cron is single-tenant (one minute interval, one Vercel cron worker) so
 * lock contention is not a concern at this scale. If we ever run multiple
 * deliverers we can swap to `findOneAndUpdate` per row.
 */
export async function claimDueDeliveries(
  now: Date,
  batchSize: number,
): Promise<WebhookDeliveryDoc[]> {
  await ensureIndexesOnce();
  const c = await col<WebhookDeliveryDoc>('webhook_deliveries');
  return c
    .find({ status: 'pending', nextAttemptAt: { $lte: now } })
    .sort({ nextAttemptAt: 1 })
    .limit(batchSize)
    .toArray();
}

export async function markSent(deliveryId: string, httpStatus: number): Promise<void> {
  const c = await col<WebhookDeliveryDoc>('webhook_deliveries');
  const now = new Date();
  await c.updateOne(
    { deliveryId },
    {
      $set: {
        status: 'sent',
        lastAttemptAt: now,
        lastResponseStatus: httpStatus,
        lastError: null,
        nextAttemptAt: null,
      },
      $inc: { attempts: 1 },
    },
  );
}

/**
 * Record a failure. Advances `attempts` and either schedules the next
 * retry (status stays `pending`) or marks `abandoned` once the retry
 * budget is exhausted.
 *
 * Returns the delivery's resulting status so the caller can log accurately.
 */
export async function markFailed(
  deliveryId: string,
  failure: { httpStatus: number | null; error: string },
): Promise<{ status: 'pending' | 'abandoned'; nextAttemptAt: Date | null; attempts: number }> {
  const c = await col<WebhookDeliveryDoc>('webhook_deliveries');
  const now = new Date();
  const cur = await c.findOne({ deliveryId });
  if (!cur) {
    throw new Error(`webhook delivery not found: ${deliveryId}`);
  }
  const nextAttempts = cur.attempts + 1;
  const truncatedError = failure.error.slice(0, 512);

  if (nextAttempts >= WEBHOOK_MAX_ATTEMPTS) {
    await c.updateOne(
      { deliveryId },
      {
        $set: {
          status: 'abandoned',
          lastAttemptAt: now,
          lastResponseStatus: failure.httpStatus,
          lastError: truncatedError,
          nextAttemptAt: null,
          attempts: nextAttempts,
        },
      },
    );
    return { status: 'abandoned', nextAttemptAt: null, attempts: nextAttempts };
  }

  // attempts is the count of completed attempts; the next retry index is
  // `nextAttempts - 1` (after the first failure → delays[0]).
  const delaySec =
    WEBHOOK_DELIVERY_RETRY_DELAYS_SEC[nextAttempts - 1] ??
    WEBHOOK_DELIVERY_RETRY_DELAYS_SEC[WEBHOOK_DELIVERY_RETRY_DELAYS_SEC.length - 1]!;
  const nextAttemptAt = new Date(now.getTime() + delaySec * 1_000);

  await c.updateOne(
    { deliveryId },
    {
      $set: {
        status: 'pending',
        lastAttemptAt: now,
        lastResponseStatus: failure.httpStatus,
        lastError: truncatedError,
        nextAttemptAt,
        attempts: nextAttempts,
      },
    },
  );
  return { status: 'pending', nextAttemptAt, attempts: nextAttempts };
}

/** Terminal-mark a single delivery without burning retry slots. */
export async function markAbandoned(deliveryId: string, reason: string): Promise<void> {
  const c = await col<WebhookDeliveryDoc>('webhook_deliveries');
  await c.updateOne(
    { deliveryId },
    {
      $set: {
        status: 'abandoned',
        lastAttemptAt: new Date(),
        lastError: reason.slice(0, 512),
        nextAttemptAt: null,
      },
    },
  );
}

/**
 * Bulk-abandon every pending delivery for a given route. Used when an admin
 * revokes or deactivates a route, there is no point retrying deliveries
 * whose destination is no longer trusted to receive them.
 */
export async function abandonPendingForRoute(routeId: string, reason: string): Promise<number> {
  await ensureIndexesOnce();
  const c = await col<WebhookDeliveryDoc>('webhook_deliveries');
  const r = await c.updateMany(
    { routeId, status: 'pending' },
    {
      $set: {
        status: 'abandoned',
        lastAttemptAt: new Date(),
        lastError: reason.slice(0, 512),
        nextAttemptAt: null,
      },
    },
  );
  return r.modifiedCount;
}

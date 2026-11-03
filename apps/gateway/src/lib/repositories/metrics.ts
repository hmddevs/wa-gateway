/**
 * Per-session metrics aggregations with a 30-second Redis cache.
 *
 * Computes 24-hour outbound, inbound and webhook-delivery counters plus
 * 24-point hourly sparklines for one session. Designed for the admin
 * dashboard, where many tabs may poll the same session in close succession;
 * the cache keeps Mongo read pressure flat under that load.
 */
import 'server-only';
import type { AdminSessionMetrics, AdminMetricsSparkPoint } from '@hmddevs/protocol';
import { col } from '../mongo';
import { getRedis } from '../redis';
import type { WebhookRouteDoc } from './webhook-routes';

const CACHE_TTL_SECONDS = 30;
const HOUR_MS = 3_600_000;

function cacheKey(sessionId: string): string {
  // v2: schema-bumped when we folded `chat_events` (paired-phone outbound
  // and live group inbound DMs) into the 24h sums. Old v1 entries would
  // have under-counted for any session that messages mostly from the
  // paired phone, so we segregate by version rather than purge on deploy.
  return `metrics:session:v2:${sessionId}`;
}

interface SparkBucket {
  hour: number;
  count: number;
}

/** Element-wise merge of two sparse hour-bucket arrays. Buckets share the
 *  "hours since hourFloor" key space so we can sum by hour directly. */
function mergeBuckets(a: SparkBucket[], b: SparkBucket[]): SparkBucket[] {
  const out = new Map<number, number>();
  for (const bucket of a) {
    out.set(bucket.hour, (out.get(bucket.hour) ?? 0) + bucket.count);
  }
  for (const bucket of b) {
    out.set(bucket.hour, (out.get(bucket.hour) ?? 0) + bucket.count);
  }
  return Array.from(out, ([hour, count]) => ({ hour, count }));
}

/**
 * Densify a sparse hour-bucket aggregation into a 24-point sparkline.
 * Input `hour` is "hours since the current hour floor" (0 = current hour,
 * 23 = 23 hours ago). Output is ordered newest-last for left-to-right
 * sparkline rendering, with hour-field re-keyed so 0 = oldest, 23 = newest.
 */
function buildSparkline(buckets: SparkBucket[]): AdminMetricsSparkPoint[] {
  const map = new Map(buckets.map((b) => [b.hour, b.count]));
  const out: AdminMetricsSparkPoint[] = [];
  for (let i = 23; i >= 0; i--) {
    out.push({ hour: 23 - i, count: map.get(i) ?? 0 });
  }
  return out;
}

export async function getSessionMetrics(
  sessionId: string,
  workerStatus: string | null,
): Promise<AdminSessionMetrics> {
  const redis = getRedis();
  const cached = await redis.get(cacheKey(sessionId));
  if (cached) {
    try {
      return JSON.parse(cached) as AdminSessionMetrics;
    } catch {
      // Corrupt cache entry, fall through and recompute. We do not delete
      // the key here; the SET below will overwrite it.
    }
  }

  const now = new Date();
  const windowFrom = new Date(now.getTime() - 24 * 60 * 60 * 1_000);

  // Truncate to the start of the current hour so sparkline buckets are stable
  // within a cache window (otherwise every recompute shifts the bucket edges).
  const hourFloor = new Date(now);
  hourFloor.setMinutes(0, 0, 0);

  // Resolve route ids whose scope is this session. Webhook deliveries do not
  // carry a sessionId directly, so we join through `webhook_routes`. Routes
  // scoped to API keys are intentionally excluded, those deliveries are
  // outbound-event-driven and don't represent inbound webhook activity for
  // this session in a meaningful way.
  const routeIds = await col<WebhookRouteDoc>('webhook_routes').then((c) =>
    c
      .find(
        { 'scope.kind': 'session', 'scope.sessionId': sessionId },
        { projection: { routeId: 1, _id: 0 } },
      )
      .toArray()
      .then((docs) => docs.map((d) => d.routeId)),
  );

  const [sentAgg, receivedAgg, chatEventAgg, webhookAgg, failedCount] = await Promise.all([
    col('messages').then((c) =>
      c
        .aggregate<SparkBucket>([
          {
            $match: {
              sessionId,
              createdAt: { $gte: windowFrom },
            },
          },
          {
            $group: {
              _id: {
                $floor: {
                  $divide: [{ $subtract: [hourFloor, '$createdAt'] }, HOUR_MS],
                },
              },
              count: { $sum: 1 },
            },
          },
          { $project: { _id: 0, hour: '$_id', count: 1 } },
        ])
        .toArray(),
    ),
    col('inbound_messages').then((c) =>
      c
        .aggregate<SparkBucket>([
          {
            $match: {
              sessionId,
              receivedAt: { $gte: windowFrom },
            },
          },
          {
            $group: {
              _id: {
                $floor: {
                  $divide: [{ $subtract: [hourFloor, '$receivedAt'] }, HOUR_MS],
                },
              },
              count: { $sum: 1 },
            },
          },
          { $project: { _id: 0, hour: '$_id', count: 1 } },
        ])
        .toArray(),
    ),
    // chat_events fold-in. Two parallel facets so a single Mongo round-trip
    // covers both paired-phone outbound (`out_device`) and live group/DM
    // inbound (`in`). History-sync rows are excluded, those replay ancient
    // chats and would skew the 24h window. DMs only on both sides
    // (counterpartyE164 != null) so groups don't double-count against the
    // outbound/inbound figures, which are explicitly DM-shaped today.
    col('chat_events').then((c) =>
      c
        .aggregate<{ sent: SparkBucket[]; received: SparkBucket[] }>([
          {
            $match: {
              sessionId,
              ts: { $gte: windowFrom },
              source: 'live',
              counterpartyE164: { $ne: null },
              direction: { $in: ['out_device', 'in'] },
            },
          },
          {
            $facet: {
              sent: [
                { $match: { direction: 'out_device' } },
                {
                  $group: {
                    _id: {
                      $floor: {
                        $divide: [{ $subtract: [hourFloor, '$ts'] }, HOUR_MS],
                      },
                    },
                    count: { $sum: 1 },
                  },
                },
                { $project: { _id: 0, hour: '$_id', count: 1 } },
              ],
              received: [
                { $match: { direction: 'in' } },
                {
                  $group: {
                    _id: {
                      $floor: {
                        $divide: [{ $subtract: [hourFloor, '$ts'] }, HOUR_MS],
                      },
                    },
                    count: { $sum: 1 },
                  },
                },
                { $project: { _id: 0, hour: '$_id', count: 1 } },
              ],
            },
          },
        ])
        .toArray(),
    ),
    routeIds.length === 0
      ? Promise.resolve([] as { delivered: number; failed: number }[])
      : col('webhook_deliveries').then((c) =>
          c
            .aggregate<{ delivered: number; failed: number }>([
              {
                $match: {
                  routeId: { $in: routeIds },
                  createdAt: { $gte: windowFrom },
                },
              },
              {
                $group: {
                  _id: null,
                  delivered: {
                    $sum: { $cond: [{ $eq: ['$status', 'sent'] }, 1, 0] },
                  },
                  failed: {
                    $sum: { $cond: [{ $eq: ['$status', 'abandoned'] }, 1, 0] },
                  },
                },
              },
            ])
            .toArray(),
        ),
    col('messages').then((c) =>
      c.countDocuments({
        sessionId,
        status: 'failed',
        createdAt: { $gte: windowFrom },
      }),
    ),
  ]);

  // `$facet` always returns a single-element array. Pull the two sides and
  // fall back to empty arrays when no chat_events exist for the window.
  const chatFacet = chatEventAgg[0] ?? { sent: [], received: [] };
  const sentMerged = mergeBuckets(sentAgg, chatFacet.sent);
  const receivedMerged = mergeBuckets(receivedAgg, chatFacet.received);

  const sentBuckets = buildSparkline(sentMerged);
  const receivedBuckets = buildSparkline(receivedMerged);

  const sent24h = sentBuckets.reduce((s, b) => s + b.count, 0);
  const received24h = receivedBuckets.reduce((s, b) => s + b.count, 0);

  const webhooks = webhookAgg[0] ?? { delivered: 0, failed: 0 };

  const metrics: AdminSessionMetrics = {
    sessionId,
    window: {
      from: windowFrom.toISOString(),
      to: now.toISOString(),
    },
    messages: {
      sent24h,
      received24h,
      failed24h: failedCount,
      sentSparkline: sentBuckets,
      receivedSparkline: receivedBuckets,
    },
    webhooks: {
      delivered24h: webhooks.delivered,
      failed24h: webhooks.failed,
    },
    workerStatus,
    cachedAt: now.toISOString(),
  };

  await redis.set(cacheKey(sessionId), JSON.stringify(metrics), 'EX', CACHE_TTL_SECONDS);
  return metrics;
}

/**
 * GET /api/admin/sessions/:id/stream
 *
 * Server-Sent Events stream for the admin Conversations panel. Replaces the
 * previous polling loop with live updates: inbound DMs, device-side outbound
 * (`chat_event`) and message status transitions all surface here.
 *
 * Auth: requireAdmin() only, read-only, no WebAuthn step-up. The admin
 * rate-limiter checks at connect time; per-event throttling would defeat the
 * purpose of a live stream.
 *
 * Redis pub/sub: subscribes to `admin:stream:<sessionId>` on a dedicated
 * `ioredis` connection (subscribe is per-connection state, so we cannot share
 * the global publisher client). Each Redis message is forwarded as one SSE
 * `data:` frame; envelope shape is `AdminStreamEnvelopeSchema`.
 *
 * Lifecycle:
 *   - Heartbeat every 15 s as an SSE comment (`:heartbeat`) so reverse
 *     proxies and Vercel's stream timeout don't drop idle connections.
 *   - Hard cap at 30 minutes, write a `:close` comment, terminate, let the
 *     `EventSource` client auto-reconnect with a fresh connection. This
 *     bounds resource usage per connection on Vercel's Node runtime.
 *   - On client disconnect (`req.signal.aborted`) we tear down the
 *     subscriber, clear timers and unblock the route handler.
 *
 * Backpressure: when `controller.desiredSize <= 0` (slow client) we drop
 * the frame and bump a per-connection counter. After 100 drops we log a
 * warning once. We never queue, the next write would only worsen the
 * lag, and admin live data is "best effort" by design (clients still see
 * the truth on the next /threads refetch).
 */
import 'server-only';
import { Redis as IoRedis } from 'ioredis';
import { ErrorCodes, SessionIdSchema } from '@hmddevs/protocol';
import { requireAdmin } from '@/lib/require-admin';
import { errorResponse } from '@/lib/http';
import { mintRequestId } from '@/lib/request-id';
import { adminLimiterKey, checkAdminLimit } from '@/lib/admin-rate-limit';
import { getSession } from '@/lib/repositories/sessions';
import { adminStreamChannel } from '@/lib/admin-stream';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const HEARTBEAT_MS = 15_000;
const STREAM_LIFETIME_MS = 30 * 60 * 1_000;
const DROP_WARN_THRESHOLD = 100;

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = mintRequestId(req.headers.get('x-request-id'));

  const guard = await requireAdmin();
  if (!guard.ok) {
    return errorResponse(guard.status, ErrorCodes.UNAUTHORIZED, guard.message, requestId);
  }

  const { id: rawId } = await ctx.params;
  const idParse = SessionIdSchema.safeParse(rawId);
  if (!idParse.success) {
    return errorResponse(400, ErrorCodes.INVALID_BODY, 'Invalid session id', requestId);
  }
  const sessionId = idParse.data;

  const ok = await checkAdminLimit(adminLimiterKey(guard.admin));
  if (!ok) {
    return errorResponse(429, ErrorCodes.RATE_LIMITED, 'Too many admin requests', requestId);
  }

  const session = await getSession(sessionId);
  if (!session) {
    return errorResponse(404, ErrorCodes.INVALID_BODY, 'Session not found', requestId);
  }

  const channel = adminStreamChannel(sessionId);
  const adminEmail = guard.admin.email;

  const encoder = new TextEncoder();
  let drops = 0;
  let dropWarnFired = false;

  // Dedicated subscriber connection. Subscribe is per-connection state in
  // Redis, sharing the global pool would cross-talk other operations.
  const subscriber = new IoRedis(env.UPSTASH_REDIS_URL, {
    tls: {},
    maxRetriesPerRequest: 2,
    enableReadyCheck: true,
    connectTimeout: 8_000,
    lazyConnect: false,
    keepAlive: 30_000,
  });

  let heartbeat: NodeJS.Timeout | undefined;
  let lifetime: NodeJS.Timeout | undefined;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const safeEnqueue = (chunk: string): void => {
        if (closed) return;
        // SSE writes are non-blocking; backpressure shows up via desiredSize.
        if (typeof controller.desiredSize === 'number' && controller.desiredSize <= 0) {
          drops++;
          if (drops >= DROP_WARN_THRESHOLD && !dropWarnFired) {
            dropWarnFired = true;
            logger.warn(
              { sessionId, adminEmail, drops, requestId, op: 'admin.stream' },
              'admin SSE stream dropping frames under backpressure',
            );
          }
          return;
        }
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch (err: unknown) {
          // Controller may have been closed by the client between checks.
          logger.debug(
            { err: (err as Error).message, sessionId, requestId, op: 'admin.stream' },
            'admin SSE enqueue after close',
          );
        }
      };

      const teardown = async (reason: 'client' | 'lifetime' | 'error'): Promise<void> => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        if (lifetime) clearTimeout(lifetime);
        try {
          if (reason === 'lifetime') {
            try {
              controller.enqueue(encoder.encode(': close\n\n'));
            } catch {
              // Stream already closed; nothing to do.
            }
          }
          try {
            await subscriber.unsubscribe(channel);
          } catch (err: unknown) {
            logger.debug(
              { err: (err as Error).message, sessionId, requestId, op: 'admin.stream' },
              'admin SSE unsubscribe failed',
            );
          }
          try {
            await subscriber.quit();
          } catch (err: unknown) {
            // `quit` can race with disconnect; force-close as fallback.
            logger.debug(
              { err: (err as Error).message, sessionId, requestId, op: 'admin.stream' },
              'admin SSE redis quit failed; disconnecting',
            );
            try {
              subscriber.disconnect();
            } catch {
              // No remaining handle.
            }
          }
        } finally {
          try {
            controller.close();
          } catch {
            // Already closed by the platform.
          }
        }
      };

      // Wire up the abort signal early so a client that disconnects mid-
      // setup still triggers cleanup once the subscriber is live.
      req.signal.addEventListener(
        'abort',
        () => {
          void teardown('client');
        },
        { once: true },
      );
      // The signal may already be aborted if the client disconnected during the
      // auth/setup path. addEventListener does not fire retroactively, so we
      // must check synchronously after wiring to avoid a 30-min resource leak.
      if (req.signal.aborted) {
        void teardown('client');
        return;
      }

      subscriber.on('error', (err) => {
        logger.warn(
          { err: err.message, sessionId, requestId, op: 'admin.stream' },
          'admin SSE redis error',
        );
        void teardown('error');
      });

      subscriber.on('message', (incomingChannel, payload) => {
        if (incomingChannel !== channel) return;
        // The publish side already JSON-encoded an `AdminStreamEnvelope`;
        // forward verbatim. We do not re-validate to avoid coupling the
        // hot path to Zod parsing, clients re-validate against the
        // exported schema and ignore unknown shapes.
        safeEnqueue(`data: ${payload}\n\n`);
      });

      try {
        await subscriber.subscribe(channel);
      } catch (err: unknown) {
        logger.warn(
          {
            err: (err as Error).message,
            sessionId,
            requestId,
            op: 'admin.stream',
          },
          'admin SSE subscribe failed',
        );
        await teardown('error');
        return;
      }

      // Open the stream with a heartbeat so proxies flush headers.
      safeEnqueue(': hello\n\n');

      heartbeat = setInterval(() => {
        safeEnqueue(': heartbeat\n\n');
      }, HEARTBEAT_MS);

      lifetime = setTimeout(() => {
        void teardown('lifetime');
      }, STREAM_LIFETIME_MS);

      logger.info(
        { sessionId, adminEmail, requestId, op: 'admin.stream' },
        'admin SSE stream open',
      );
    },
    cancel() {
      // ReadableStream.cancel is invoked when the consumer drops the stream;
      // the abort handler covers the same case but cancel() may fire first
      // depending on platform. The teardown closure is idempotent via the
      // `closed` flag, so calling both paths is safe.
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      if (lifetime) clearTimeout(lifetime);
      void subscriber
        .unsubscribe(channel)
        .catch(() => undefined)
        .then(() => subscriber.quit())
        .catch(() => {
          try {
            subscriber.disconnect();
          } catch {
            // No remaining handle.
          }
        });
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Request-Id': requestId,
    },
  });
}

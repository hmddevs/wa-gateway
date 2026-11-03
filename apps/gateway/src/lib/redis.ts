/**
 * Redis clients.
 *
 * - `ioredis` for Pub/Sub (publish), BLMOVE/LREM pending-list operations,
 *   and Streams (admin log tail). Long-lived TCP connection; NOT suitable
 *   for serverless, so in Vercel environments we keep it lazy and short.
 *
 * Upstash tolerates pipelined commands from short-lived instances fine. For
 * Pub/Sub on the sync-confirm path we now hold ONE long-lived shared subscriber
 * (`getSharedSubscriber`) that multiplexes any number of concurrent one-shot
 * subscriptions, so a confirmed send no longer pays a fresh TLS handshake
 * (~98ms in lhr) per call. On a self-hosted deployment the process is persistent, so the
 * connection stays warm across requests.
 */
import 'server-only';
import { Redis as IoRedis } from 'ioredis';
import { env } from './env';

/**
 * TLS follows the URL scheme, which is exactly what `rediss://` means. Upstash
 * is always `rediss://` so production is unchanged; a local `redis://` for
 * development no longer fails the handshake against a server that never
 * offered TLS in the first place.
 */
function tlsForUrl(url: string): Record<string, never> | undefined {
  return url.startsWith('rediss://') ? {} : undefined;
}

/** Per-channel pending slot held on the shared subscriber. */
interface PendingListen {
  resolve: (payload: unknown | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

// eslint-disable-next-line vars-on-top, no-var
declare global {
  // eslint-disable-next-line no-var
  var __hmdRedis: IoRedis | undefined;
  // eslint-disable-next-line no-var
  var __hmdRedisSub: IoRedis | undefined;
  // eslint-disable-next-line no-var
  var __hmdSubListeners: Map<string, PendingListen> | undefined;
}

export function getRedis(): IoRedis {
  if (global.__hmdRedis && global.__hmdRedis.status !== 'end') {
    return global.__hmdRedis;
  }
  const client = new IoRedis(env.UPSTASH_REDIS_URL, {
    tls: tlsForUrl(env.UPSTASH_REDIS_URL),
    maxRetriesPerRequest: 2,
    enableReadyCheck: true,
    connectTimeout: 8_000,
    lazyConnect: false,
    keepAlive: 30_000,
  });
  client.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.error({ err: err.message }, '[redis] error');
  });
  global.__hmdRedis = client;
  return client;
}

/**
 * The single long-lived Pub/Sub subscriber that backs `subscribeOnce`.
 *
 * Must NOT reuse `global.__hmdRedis`, that client serves publish/regular
 * commands, and a SUBSCRIBE puts the connection into pub/sub mode. Incoming
 * messages are routed by channel to the matching pending slot in
 * `global.__hmdSubListeners`. `maxRetriesPerRequest: null` is required: the
 * default (2) makes ioredis give up reconnecting after two attempts, which
 * would silently drop this long-lived subscription.
 */
function getSharedSubscriber(): IoRedis {
  if (global.__hmdRedisSub && global.__hmdRedisSub.status !== 'end') {
    return global.__hmdRedisSub;
  }
  if (!global.__hmdSubListeners) global.__hmdSubListeners = new Map();

  const sub = new IoRedis(env.UPSTASH_REDIS_URL, {
    tls: tlsForUrl(env.UPSTASH_REDIS_URL),
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    connectTimeout: 10_000,
    keepAlive: 30_000,
    lazyConnect: false,
  });

  // Route each delivered message to its channel's pending slot, then clean up
  // that slot and unsubscribe, the subscription is one-shot per caller.
  sub.on('message', (ch: string, payload: string) => {
    const pending = global.__hmdSubListeners?.get(ch);
    if (!pending) return;
    global.__hmdSubListeners!.delete(ch);
    sub.unsubscribe(ch).catch(() => {});
    clearTimeout(pending.timer);
    try {
      pending.resolve(JSON.parse(payload));
    } catch {
      // Malformed JSON on a per-message channel, surface as null so the route
      // returns `queued`; the worker retries / receipts catch up.
      pending.resolve(null);
    }
  });

  sub.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.error({ err: err.message }, '[redis:sub] shared subscriber error');
  });

  global.__hmdRedisSub = sub;
  return sub;
}

/**
 * One-shot Pub/Sub subscriber for the sync-confirm flow.
 *
 * Registers a listener for `channel` on the shared long-lived subscriber and
 * returns a two-stage handle so the caller can publish ONLY after SUBSCRIBE has
 * been ack'd by the server, closing the fast-ack race. The slot owns its own
 * timeout and is unsubscribed on delivery, timeout, or subscribe failure.
 */
export interface SubscribeOnceHandle {
  /** Resolves once the SUBSCRIBE has been acknowledged by Redis. */
  ready: Promise<void>;
  /** Resolves with the parsed JSON envelope, or `null` on timeout. */
  message: Promise<unknown | null>;
}

export function subscribeOnce(channel: string, timeoutMs: number): SubscribeOnceHandle {
  const sub = getSharedSubscriber();
  if (!global.__hmdSubListeners) global.__hmdSubListeners = new Map();

  let readyResolve!: () => void;
  let readyReject!: (err: Error) => void;
  let readySettled = false;
  const ready = new Promise<void>((res, rej) => {
    readyResolve = (): void => {
      if (readySettled) return;
      readySettled = true;
      res();
    };
    readyReject = (err: Error): void => {
      if (readySettled) return;
      readySettled = true;
      rej(err);
    };
  });

  const message = new Promise<unknown | null>((resolve) => {
    // why: also reject `ready` so a hung SUBSCRIBE can't outlast the caller's
    // confirmTimeoutMs budget, without this, the route's `await handle.ready`
    // is bounded only by ioredis's connectTimeout, blowing the function clock.
    const timer = setTimeout(() => {
      global.__hmdSubListeners?.delete(channel);
      sub.unsubscribe(channel).catch(() => {});
      readyReject(new Error('subscribe timeout'));
      resolve(null);
    }, timeoutMs);

    global.__hmdSubListeners!.set(channel, { resolve, timer });

    sub.subscribe(channel).then(
      () => readyResolve(),
      (err: Error) => {
        global.__hmdSubListeners?.delete(channel);
        clearTimeout(timer);
        readyReject(err);
        resolve(null);
      },
    );
  });

  return { ready, message };
}

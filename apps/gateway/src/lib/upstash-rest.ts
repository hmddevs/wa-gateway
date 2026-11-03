/** Singleton Upstash REST client used by every Ratelimit limiter. */
import 'server-only';
import { Redis as UpstashRedis } from '@upstash/redis';
import { env } from './env';

declare global {
  // eslint-disable-next-line no-var
  var __hmdUpstashRest: UpstashRedis | undefined;
}

export function getRest(): UpstashRedis {
  if (global.__hmdUpstashRest) return global.__hmdUpstashRest;
  const client = new UpstashRedis({
    url: env.UPSTASH_REDIS_REST_URL,
    token: env.UPSTASH_REDIS_REST_TOKEN,
  });
  global.__hmdUpstashRest = client;
  return client;
}

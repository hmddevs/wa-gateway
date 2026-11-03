/**
 * Environment validation. Runs once at module load; crashes the server fast
 * if anything is missing or malformed at RUNTIME. Build-time (`next build`)
 * skips validation when SKIP_ENV_VALIDATION=1.
 */
import 'server-only';
import { z } from 'zod';

const base64Bytes = (n: number) =>
  z
    .string()
    .min(1)
    .refine(
      (v) => {
        try {
          return Buffer.from(v, 'base64').length === n;
        } catch {
          return false;
        }
      },
      { message: `Must be base64 of exactly ${n} bytes` },
    );

const pem = z.string().refine((v) => v.includes('-----BEGIN') && v.includes('-----END'), {
  message: 'Must be a PEM-encoded key',
});

const adminCredsSchema = z.string().refine(
  (v) => {
    try {
      const parsed = JSON.parse(v);
      if (!Array.isArray(parsed) || parsed.length === 0) return false;
      return parsed.every(
        (e) =>
          e &&
          typeof e.email === 'string' &&
          typeof e.hash === 'string' &&
          e.hash.startsWith('scrypt$'),
      );
    } catch {
      return false;
    }
  },
  { message: 'Must be JSON array of {email, hash} with scrypt$ hashes' },
);

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    GATEWAY_PUBLIC_URL: z.string().url(),

    MONGODB_URI: z.string().startsWith('mongodb'),
    MONGODB_DB: z.string().min(1).default('hmd_wa'),

    UPSTASH_REDIS_URL: z.string().startsWith('rediss://'),
    UPSTASH_REDIS_REST_URL: z.string().url(),
    UPSTASH_REDIS_REST_TOKEN: z.string().min(1),

    SERVER_PEPPER: base64Bytes(32),
    INBOUND_ENCRYPTION_KEY: base64Bytes(32),
    WEBHOOK_SIGNING_DEFAULT_SECRET: base64Bytes(32),
    // Symmetric key used to encrypt per-route webhook signing secrets at rest.
    // 32 bytes, base64. Rotation requires re-encrypting existing routes (out of scope here).
    WEBHOOK_DELIVERY_KEY: base64Bytes(32),

    WORKER_JWT_SIGNING_KEY: pem,
    WORKER_JWT_PUBLIC_KEY: pem,

    WORKER_WIRE_SECRET: base64Bytes(32),

    NEXTAUTH_URL: z.string().url(),
    NEXTAUTH_SECRET: z.string().min(32),

    ADMIN_CREDENTIALS: adminCredsSchema,
    ADMIN_EMAILS: z.string().optional(),

    RESEND_API_KEY: z.string().min(1),
    ALERTS_FROM_EMAIL: z.string().email(),
    // Inbox an operator actually reads. Optional; falls back to ALERTS_FROM_EMAIL.
    ALERTS_TO_EMAIL: z.string().email().optional(),

    WEBAUTHN_RP_NAME: z.string().min(1).default('HMD WA Gateway'),
    WEBAUTHN_RP_ID: z.string().min(1),

    WORKER_ID: z.string().min(1).default('primary'),

    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).optional(),

    // In-process job scheduler toggle for the long-running (self-hosted) deployment.
    // OFF by default; '1' starts the scheduler from instrumentation.ts. On Vercel
    // the HTTP cron routes drive the jobs instead, so this stays '0' there.
    SCHEDULER_ENABLED: z.enum(['0', '1']).default('0'),

    // Restores the per-tick Redis SET NX PX / DEL cross-replica job lock in
    // scheduler.ts. OFF by default: the gateway runs as exactly one instance
    // (single-instance assumption), so the in-process `running` mutex alone is
    // sufficient and an idle tick costs zero Redis commands. Set to '1' only if
    // the gateway is ever scaled to more than one instance.
    SCHEDULER_DISTRIBUTED_LOCKS: z.enum(['0', '1']).default('0'),

    // Bearer secret guarding the public HTTP cron routes. Optional in general,
    // but required when the in-process scheduler is OFF (Vercel-style), because
    // the HTTP routes are then the only trigger and must not be left open.
    CRON_SECRET: z.string().min(1).optional(),

    // When "1", honour the CF-Connecting-IP header for the real client IP, but
    // ONLY when the immediate upstream (the configured TRUSTED_CLIENT_IP_HEADER)
    // is inside a published Cloudflare range. Off by default (grey-cloud): until
    // Cloudflare proxying is live, the trusted header is already the true
    // client IP and CF headers are spoofable. Set to "1" the moment the zone
    // goes orange-cloud (proxied).
    TRUST_CLOUDFLARE: z.enum(['0', '1']).default('0'),

    // When "1", reject any request that did NOT arrive through Cloudflare's
    // proxy, closing the WAF-bypass hole where an attacker hits the origin IP
    // directly. The proof is the trusted-header peer IP (the origin's immediate
    // TCP peer) being inside a published Cloudflare range; see middleware.ts
    // for the full exemption order (health check, worker callbacks, and
    // internal-network traffic always pass). Off by default so the build can
    // ship dark, then be flipped to "1" only once Cloudflare proxying is
    // confirmed live. The flag is also read directly from process.env in the
    // edge middleware, which must
    // not import this server-only module.
    ENFORCE_CLOUDFLARE_ORIGIN: z.enum(['0', '1']).default('0'),

    // Per-IP request cap (requests per minute) for the unauthenticated edge
    // limiter. Default 1200 suits a trusted integration server; raising it
    // via env requires a restart to take effect. This caps gateway INGRESS
    // only and never affects the serial per-WhatsApp-session send rate
    // (owned by the worker).
    RATE_LIMIT_IP_PER_MIN: z.coerce.number().int().positive().default(1200),

    // Header carrying the real client IP, as set by the trusted reverse proxy
    // in front of this gateway. No default: if unset, every request resolves
    // to the 0.0.0.0 sentinel, so IP allowlists reject everything and per-IP
    // rate limits share a single bucket. Only ever point this at a header
    // your own proxy sets/overwrites itself, never one a client can send
    // directly, or IP allowlisting and per-IP rate limiting become trivially
    // spoofable. See `.env.example` and `docs/SELF_HOSTING.md` for worked
    // examples.
    TRUSTED_CLIENT_IP_HEADER: z.string().min(1).optional(),
  })
  .superRefine((val, ctx) => {
    // When the in-process scheduler does not own the jobs, the HTTP cron routes
    // are the live trigger and CRON_SECRET must be set to authenticate them.
    if (val.SCHEDULER_ENABLED !== '1' && !val.CRON_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CRON_SECRET'],
        message: 'Required when SCHEDULER_ENABLED is not "1" (HTTP cron routes need a secret)',
      });
    }
  });

export type Env = z.infer<typeof EnvSchema>;

function parseEnv(): Env {
  const normalised: Record<string, string | undefined> = { ...process.env };
  for (const k of ['WORKER_JWT_SIGNING_KEY', 'WORKER_JWT_PUBLIC_KEY'] as const) {
    const v = normalised[k];
    if (typeof v === 'string' && v.includes('\\n')) {
      normalised[k] = v.replace(/\\n/g, '\n');
    }
  }
  const parsed = EnvSchema.safeParse(normalised);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    // eslint-disable-next-line no-console
    console.error(`[env] Invalid environment:\n${issues}`);
    throw new Error('Environment validation failed. See logs for details.');
  }
  return parsed.data;
}

const shouldValidate = process.env.SKIP_ENV_VALIDATION !== '1';

export const env: Env = shouldValidate ? parseEnv() : (process.env as any as Env);

export const isProd = env.NODE_ENV === 'production';

export interface AdminCredential {
  email: string;
  hash: string;
}

let cachedCreds: AdminCredential[] | null = null;
export function adminCredentials(): AdminCredential[] {
  if (cachedCreds) return cachedCreds;
  try {
    const arr = JSON.parse(env.ADMIN_CREDENTIALS) as AdminCredential[];
    cachedCreds = arr.map((c) => ({ email: c.email.trim().toLowerCase(), hash: c.hash }));
    return cachedCreds;
  } catch {
    cachedCreds = [];
    return cachedCreds;
  }
}

export function adminEmailAllowlist(): string[] {
  if (env.ADMIN_EMAILS && env.ADMIN_EMAILS.trim().length > 0) {
    return env.ADMIN_EMAILS.split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  }
  return adminCredentials().map((c) => c.email);
}

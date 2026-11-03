/**
 * `HmdWAClient`, thin, typed transport over `globalThis.fetch`.
 *
 * Zero runtime deps. All retry/idempotency/timeout logic lives in the
 * `request` helper here so the surface methods stay declarative.
 */
import type {
  GetMessageResponse,
  ListGroupsResponse,
  ListMessagesResponse,
  PresenceRequest,
  PresenceResponse,
  PresenceState,
  ReactionResponse,
  SendMessageRequest,
  SendMessageResponse,
  WorkerStatusResponse,
} from '@hmddevs/protocol';
import { CLIENT_ERROR_CODES, HmdWAError } from './errors.js';

/** SDK version. Bumped in lockstep with `package.json`. */
export const SDK_VERSION = '0.3.0';
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RETRIES = 3;
const MAX_RETRY_DELAY_MS = 30_000;
const RETRYABLE_STATUSES = new Set<number>([408, 429, 500, 502, 503, 504]);

export interface HmdWAClientOptions {
  /** Defaults to `process.env.HMD_WA_API_KEY`. */
  apiKey?: string;
  /** Base URL of the gateway, e.g. `https://wa.example.com`. Trailing slash is trimmed. */
  baseUrl: string;
  /** Per-attempt timeout in ms. Defaults to 10_000. */
  timeoutMs?: number;
  /** Max retries on retryable failures. Defaults to 3 (so up to 4 attempts total). */
  maxRetries?: number;
  /** Inject a custom `fetch` (tests, custom transports). Defaults to `globalThis.fetch`. */
  fetch?: typeof fetch;
  /** Appended to the User-Agent string. */
  userAgent?: string;
}

export interface HmdWASendOptions {
  /**
   * Idempotency key, same `apiKey` + same key + 24h window = same `messageId`.
   * If omitted, falls back to `req.idempotencyKey`. Sent inside the request
   * body (the gateway reads it from there; no header is set).
   */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export interface HmdWASendAndConfirmOptions extends HmdWASendOptions {
  /**
   * How long the gateway waits for the worker's terminal ack before returning
   * `status: 'queued'`. Range 300–30000 ms; default 5000. The SDK extends its
   * own per-attempt timeout to this value plus 2000 ms so a soft confirm
   * timeout from the gateway never trips an SDK retry on the same call.
   */
  confirmTimeoutMs?: number;
}

export interface HmdWAGetOptions {
  signal?: AbortSignal;
}

export interface HmdWAListOptions {
  limit?: number;
  before?: string;
  signal?: AbortSignal;
}

export interface HmdWAStatusOptions {
  signal?: AbortSignal;
}

export interface HmdWAListGroupsOptions {
  signal?: AbortSignal;
}

export interface HmdWAReactOptions {
  signal?: AbortSignal;
}

export interface HmdWAPresenceOptions {
  /** Target a specific recipient, sends a chat-scoped indicator (typing, recording). */
  to?: string;
  signal?: AbortSignal;
}

/**
 * Session id resolution for `setPresence` / `setTyping`. The gateway derives
 * the session from the API key, so the path-positional id MUST match the
 * key's bound session. Pass it explicitly for clarity, or let the SDK resolve
 * it from `process.env.HMD_WA_SESSION_ID` (or fall back to `'default'`).
 */
export interface HmdWASessionScopedOptions extends HmdWAPresenceOptions {
  sessionId?: string;
}

export interface HmdWAClient {
  /**
   * Send an outbound message.
   *
   * `req.purpose` (required) declares the message's intent, one of
   * `'otp' | 'magic_link' | 'transactional' | 'notification' | 'support' |
   * 'marketing' | 'other'`. The gateway uses it for routing, audit, and
   * compliance reporting; there is no default. Pick the narrowest value that
   * fits the call site.
   *
   * `projectId` is NOT a parameter here, it is derived server-side from the
   * API key's bound project.
   */
  send(req: SendMessageRequest, opts?: HmdWASendOptions): Promise<SendMessageResponse>;
  /**
   * Like `send`, but forces `confirm: true` and waits for a terminal status
   * (`'sent' | 'failed' | 'queued'`). Caller treats `status !== 'sent'` as the
   * cue to fall back to a secondary channel (e.g. email).
   */
  sendAndConfirm(
    req: SendMessageRequest,
    opts?: HmdWASendAndConfirmOptions,
  ): Promise<SendMessageResponse>;
  get(messageId: string, opts?: HmdWAGetOptions): Promise<GetMessageResponse>;
  list(opts?: HmdWAListOptions): Promise<ListMessagesResponse>;
  status(opts?: HmdWAStatusOptions): Promise<WorkerStatusResponse>;
  /**
   * Discover the WhatsApp group JIDs the bound session belongs to, so one can
   * be passed as `to` on `send`. Requires the `read:groups` scope.
   */
  listGroups(opts?: HmdWAListGroupsOptions): Promise<ListGroupsResponse>;
  /** Set a reaction emoji on a prior outbound message. Replaces any existing reaction. */
  react(messageId: string, emoji: string, opts?: HmdWAReactOptions): Promise<ReactionResponse>;
  /** Clear the reaction this session set on a prior outbound message. */
  unreact(messageId: string, opts?: HmdWAReactOptions): Promise<ReactionResponse>;
  /** Send a typing indicator to a recipient. `on=false` clears it (`paused`). */
  setTyping(to: string, on: boolean, opts?: HmdWASessionScopedOptions): Promise<PresenceResponse>;
  /** Set the session's presence (`available`, `unavailable`) or per-chat indicator. */
  setPresence(state: PresenceState, opts?: HmdWASessionScopedOptions): Promise<PresenceResponse>;
}

interface ResolvedConfig {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  maxRetries: number;
  fetch: typeof fetch;
  userAgent: string;
}

/**
 * Construct a client. Throws `HmdWAError` (`CONFIG_ERROR`) when required
 * configuration is missing or the runtime lacks `fetch`.
 */
export function createClient(options: HmdWAClientOptions): HmdWAClient {
  const cfg = resolveConfig(options);

  return {
    async send(req, opts) {
      const idempotencyKey = opts?.idempotencyKey ?? req.idempotencyKey;
      if (idempotencyKey !== undefined) {
        if (
          typeof idempotencyKey !== 'string' ||
          idempotencyKey.length < 8 ||
          idempotencyKey.length > 128
        ) {
          throw new HmdWAError({
            code: CLIENT_ERROR_CODES.CONFIG_ERROR,
            message: 'idempotencyKey must be 8-128 characters',
          });
        }
      }
      // The gateway reads the idempotency key from the request body. Sending it
      // there (and not as a separate header) keeps a single source of truth and
      // makes retries identical-body guaranteed.
      const body: SendMessageRequest = idempotencyKey ? { ...req, idempotencyKey } : req;

      return request<SendMessageResponse>(cfg, {
        method: 'POST',
        path: '/v1/messages',
        body,
        headers: { 'Content-Type': 'application/json' },
        signal: opts?.signal,
      });
    },

    async sendAndConfirm(req, opts) {
      const confirmTimeoutMs = opts?.confirmTimeoutMs ?? 5_000;
      if (
        !Number.isInteger(confirmTimeoutMs) ||
        confirmTimeoutMs < 300 ||
        confirmTimeoutMs > 30_000
      ) {
        throw new HmdWAError({
          code: CLIENT_ERROR_CODES.CONFIG_ERROR,
          message: 'confirmTimeoutMs must be an integer between 300 and 30000',
        });
      }
      const idempotencyKey = opts?.idempotencyKey ?? req.idempotencyKey;
      if (idempotencyKey !== undefined) {
        if (
          typeof idempotencyKey !== 'string' ||
          idempotencyKey.length < 8 ||
          idempotencyKey.length > 128
        ) {
          throw new HmdWAError({
            code: CLIENT_ERROR_CODES.CONFIG_ERROR,
            message: 'idempotencyKey must be 8-128 characters',
          });
        }
      }
      const body: SendMessageRequest = {
        ...req,
        ...(idempotencyKey ? { idempotencyKey } : {}),
        confirm: true,
        confirmTimeoutMs,
      };
      // why: extend the per-attempt timeout past the gateway's confirm window so
      // a soft 'queued' return never collides with the SDK's own request timeout.
      return request<SendMessageResponse>(cfg, {
        method: 'POST',
        path: '/v1/messages',
        body,
        headers: { 'Content-Type': 'application/json' },
        signal: opts?.signal,
        timeoutMs: confirmTimeoutMs + 2_000,
      });
    },

    async get(messageId, opts) {
      if (typeof messageId !== 'string' || messageId.length === 0) {
        throw new HmdWAError({
          code: CLIENT_ERROR_CODES.CONFIG_ERROR,
          message: 'messageId must be a non-empty string',
        });
      }
      return request<GetMessageResponse>(cfg, {
        method: 'GET',
        path: `/v1/messages/${encodeURIComponent(messageId)}`,
        signal: opts?.signal,
      });
    },

    async list(opts) {
      const params = new URLSearchParams();
      if (opts?.limit !== undefined) {
        if (!Number.isInteger(opts.limit) || opts.limit <= 0) {
          throw new HmdWAError({
            code: CLIENT_ERROR_CODES.CONFIG_ERROR,
            message: 'limit must be a positive integer',
          });
        }
        params.set('limit', String(opts.limit));
      }
      if (opts?.before) params.set('before', opts.before);
      const query = params.toString();
      return request<ListMessagesResponse>(cfg, {
        method: 'GET',
        path: query ? `/v1/messages?${query}` : '/v1/messages',
        signal: opts?.signal,
      });
    },

    async status(opts) {
      return request<WorkerStatusResponse>(cfg, {
        method: 'GET',
        path: '/v1/worker/status',
        signal: opts?.signal,
      });
    },

    async listGroups(opts) {
      return request<ListGroupsResponse>(cfg, {
        method: 'GET',
        path: '/v1/groups',
        signal: opts?.signal,
      });
    },

    async react(messageId, emoji, opts) {
      if (typeof messageId !== 'string' || messageId.length === 0) {
        throw new HmdWAError({
          code: CLIENT_ERROR_CODES.CONFIG_ERROR,
          message: 'messageId must be a non-empty string',
        });
      }
      if (typeof emoji !== 'string' || emoji.length === 0) {
        throw new HmdWAError({
          code: CLIENT_ERROR_CODES.CONFIG_ERROR,
          message: 'emoji must be a non-empty string, use unreact() to clear',
        });
      }
      return request<ReactionResponse>(cfg, {
        method: 'POST',
        path: `/v1/messages/${encodeURIComponent(messageId)}/reactions`,
        body: { emoji },
        headers: { 'Content-Type': 'application/json' },
        signal: opts?.signal,
      });
    },

    async unreact(messageId, opts) {
      if (typeof messageId !== 'string' || messageId.length === 0) {
        throw new HmdWAError({
          code: CLIENT_ERROR_CODES.CONFIG_ERROR,
          message: 'messageId must be a non-empty string',
        });
      }
      return request<ReactionResponse>(cfg, {
        method: 'DELETE',
        path: `/v1/messages/${encodeURIComponent(messageId)}/reactions`,
        signal: opts?.signal,
      });
    },

    async setTyping(to, on, opts) {
      if (typeof to !== 'string' || to.length === 0) {
        throw new HmdWAError({
          code: CLIENT_ERROR_CODES.CONFIG_ERROR,
          message: 'to must be a non-empty string',
        });
      }
      const sessionId = resolveSessionId(opts?.sessionId);
      const body: PresenceRequest = { state: on ? 'composing' : 'paused', to };
      return request<PresenceResponse>(cfg, {
        method: 'POST',
        path: `/v1/sessions/${encodeURIComponent(sessionId)}/presence`,
        body,
        headers: { 'Content-Type': 'application/json' },
        signal: opts?.signal,
      });
    },

    async setPresence(state, opts) {
      const sessionId = resolveSessionId(opts?.sessionId);
      const body: PresenceRequest = opts?.to ? { state, to: opts.to } : { state };
      return request<PresenceResponse>(cfg, {
        method: 'POST',
        path: `/v1/sessions/${encodeURIComponent(sessionId)}/presence`,
        body,
        headers: { 'Content-Type': 'application/json' },
        signal: opts?.signal,
      });
    },
  };
}

function resolveSessionId(explicit?: string): string {
  if (explicit && explicit.length > 0) return explicit;
  const fromEnv = typeof process !== 'undefined' ? process.env?.HMD_WA_SESSION_ID : undefined;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return 'default';
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function resolveConfig(options: HmdWAClientOptions): ResolvedConfig {
  const apiKey =
    options.apiKey ?? (typeof process !== 'undefined' ? process.env?.HMD_WA_API_KEY : undefined);
  if (!apiKey || typeof apiKey !== 'string') {
    throw new HmdWAError({
      code: CLIENT_ERROR_CODES.CONFIG_ERROR,
      message:
        'Missing API key. Pass `apiKey` to hmdWA() or set HMD_WA_API_KEY in the environment.',
    });
  }

  const fetchImpl = options.fetch ?? (globalThis.fetch as typeof fetch | undefined);
  if (typeof fetchImpl !== 'function') {
    throw new HmdWAError({
      code: CLIENT_ERROR_CODES.CONFIG_ERROR,
      message:
        'globalThis.fetch is not available. Use Node 18+ or pass a `fetch` implementation explicitly.',
    });
  }

  if (!options.baseUrl || typeof options.baseUrl !== 'string') {
    throw new HmdWAError({
      code: CLIENT_ERROR_CODES.CONFIG_ERROR,
      message: 'Missing `baseUrl`. Pass the gateway base URL to hmdWA().',
    });
  }
  const baseUrl = options.baseUrl.replace(/\/+$/, '');

  const timeoutMs =
    options.timeoutMs !== undefined && options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_TIMEOUT_MS;
  const maxRetries =
    options.maxRetries !== undefined && options.maxRetries >= 0
      ? Math.floor(options.maxRetries)
      : DEFAULT_MAX_RETRIES;

  const baseUa = `@hmddevs/wa-sdk/${SDK_VERSION} node`;
  const userAgent = options.userAgent ? `${baseUa} ${options.userAgent}` : baseUa;

  return { apiKey, baseUrl, timeoutMs, maxRetries, fetch: fetchImpl, userAgent };
}

interface RequestSpec {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Override the per-attempt timeout for this call only. */
  timeoutMs?: number;
}

async function request<T>(cfg: ResolvedConfig, spec: RequestSpec): Promise<T> {
  const url = `${cfg.baseUrl}${spec.path}`;
  const baseHeaders: Record<string, string> = {
    Authorization: `Bearer ${cfg.apiKey}`,
    Accept: 'application/json',
    'User-Agent': cfg.userAgent,
    ...spec.headers,
  };
  const bodyPayload = spec.body !== undefined ? JSON.stringify(spec.body) : undefined;
  const effectiveCfg =
    spec.timeoutMs !== undefined && spec.timeoutMs > 0
      ? { ...cfg, timeoutMs: spec.timeoutMs }
      : cfg;

  let lastError: HmdWAError | undefined;
  const totalAttempts = effectiveCfg.maxRetries + 1;

  for (let attempt = 0; attempt < totalAttempts; attempt++) {
    if (spec.signal?.aborted) {
      throw new HmdWAError({
        code: CLIENT_ERROR_CODES.ABORTED,
        message: 'Request aborted by caller',
        retryable: false,
      });
    }

    const attemptResult = await runAttempt<T>(
      effectiveCfg,
      url,
      spec.method,
      baseHeaders,
      bodyPayload,
      spec.signal,
    );
    if (attemptResult.kind === 'ok') return attemptResult.value;

    lastError = attemptResult.error;

    if (!attemptResult.error.retryable || attempt === totalAttempts - 1) {
      throw attemptResult.error;
    }

    const delay = computeRetryDelayMs(attempt, attemptResult.retryAfterHeader);
    await sleepWithSignal(delay, spec.signal);
  }

  // Unreachable in practice, the loop either returns or throws, but TS
  // can't prove that, so guard explicitly.
  throw (
    lastError ??
    new HmdWAError({
      code: CLIENT_ERROR_CODES.INVALID_RESPONSE,
      message: 'Request failed without producing an error',
    })
  );
}

interface AttemptOk<T> {
  kind: 'ok';
  value: T;
}
interface AttemptErr {
  kind: 'err';
  error: HmdWAError;
  retryAfterHeader?: string | null;
}

async function runAttempt<T>(
  cfg: ResolvedConfig,
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  externalSignal: AbortSignal | undefined,
): Promise<AttemptOk<T> | AttemptErr> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    try {
      controller.abort(new Error('timeout'));
    } catch {
      controller.abort();
    }
  }, cfg.timeoutMs);

  const onExternalAbort = (): void => {
    try {
      controller.abort(externalSignal?.reason);
    } catch {
      controller.abort();
    }
  };
  if (externalSignal) {
    if (externalSignal.aborted) onExternalAbort();
    else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }

  const startedAt = Date.now();
  let res: Response;
  try {
    res = await cfg.fetch(url, {
      method,
      headers,
      body,
      signal: controller.signal,
    });
  } catch (err: unknown) {
    clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);

    // Distinguish caller-aborted vs timeout vs network.
    if (externalSignal?.aborted) {
      return {
        kind: 'err',
        error: new HmdWAError({
          code: CLIENT_ERROR_CODES.ABORTED,
          message: 'Request aborted by caller',
          retryable: false,
          cause: err,
        }),
      };
    }
    const elapsed = Date.now() - startedAt;
    if (controller.signal.aborted && elapsed >= cfg.timeoutMs - 50) {
      return {
        kind: 'err',
        error: new HmdWAError({
          code: CLIENT_ERROR_CODES.TIMEOUT,
          message: `Request timed out after ${cfg.timeoutMs}ms`,
          retryable: true,
          cause: err,
        }),
      };
    }
    return {
      kind: 'err',
      error: new HmdWAError({
        code: CLIENT_ERROR_CODES.NETWORK_ERROR,
        message: `Network error: ${(err as Error)?.message ?? 'unknown'}`,
        retryable: true,
        cause: err,
      }),
    };
  }

  clearTimeout(timer);
  if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);

  // Read body once; we may need it for both success parsing and error reporting.
  const rawText = await res.text().catch(() => '');
  const parsedBody: unknown = rawText.length > 0 ? safeJsonParse(rawText) : undefined;

  if (res.ok) {
    if (parsedBody === undefined) {
      return {
        kind: 'err',
        error: new HmdWAError({
          code: CLIENT_ERROR_CODES.INVALID_RESPONSE,
          message: `Gateway returned ${res.status} with empty body`,
          httpStatus: res.status,
          requestId: res.headers.get('x-request-id') ?? undefined,
          retryable: false,
        }),
      };
    }
    if (parsedBody === PARSE_FAILURE) {
      return {
        kind: 'err',
        error: new HmdWAError({
          code: CLIENT_ERROR_CODES.INVALID_RESPONSE,
          message: `Gateway returned ${res.status} with non-JSON body`,
          httpStatus: res.status,
          requestId: res.headers.get('x-request-id') ?? undefined,
          retryable: false,
          rawBody: rawText.slice(0, 512),
        }),
      };
    }
    return { kind: 'ok', value: parsedBody as T };
  }

  // Non-2xx: build a typed error. Use parsed envelope when possible.
  const envelope = parsedBody === PARSE_FAILURE ? undefined : parsedBody;
  const error = HmdWAError.fromResponse(
    res.status,
    envelope,
    parsedBody === PARSE_FAILURE ? rawText.slice(0, 512) : undefined,
  );
  // Override requestId from header if envelope didn't carry one.
  const headerReqId = res.headers.get('x-request-id') ?? undefined;
  if (!error.requestId && headerReqId) {
    Object.assign(error, { requestId: headerReqId });
  }

  // 401 = misconfigured key, never retry. Other 4xx (except 408/429) likewise.
  if (!RETRYABLE_STATUSES.has(res.status)) {
    Object.assign(error, { retryable: false });
  }

  return { kind: 'err', error, retryAfterHeader: res.headers.get('retry-after') };
}

const PARSE_FAILURE = Symbol('parse-failure');

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return PARSE_FAILURE;
  }
}

function computeRetryDelayMs(attempt: number, retryAfter: string | null | undefined): number {
  if (retryAfter) {
    const fromHeader = parseRetryAfterMs(retryAfter);
    if (fromHeader !== null) return Math.min(fromHeader, MAX_RETRY_DELAY_MS);
  }
  // Exponential backoff with jitter: min(30s, 250 * 2^attempt) + random(0..250)ms
  const base = Math.min(MAX_RETRY_DELAY_MS, 250 * 2 ** attempt);
  const jitter = Math.floor(Math.random() * 250);
  return Math.min(MAX_RETRY_DELAY_MS, base + jitter);
}

function parseRetryAfterMs(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  // Integer seconds.
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isFinite(seconds) || seconds < 0) return null;
    return seconds * 1_000;
  }

  // HTTP-date.
  const ts = Date.parse(trimmed);
  if (Number.isNaN(ts)) return null;
  const delta = ts - Date.now();
  return delta > 0 ? delta : 0;
}

function sleepWithSignal(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(
        new HmdWAError({
          code: CLIENT_ERROR_CODES.ABORTED,
          message: 'Request aborted by caller',
          retryable: false,
        }),
      );
      return;
    }
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(
        new HmdWAError({
          code: CLIENT_ERROR_CODES.ABORTED,
          message: 'Request aborted by caller',
          retryable: false,
        }),
      );
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * CLI provider transport recovery: retry transient connection failures before
 * surfacing a terminal stream error. Mirrors Desktop recovering-fetch policy
 * for the single Bun/Node fetch channel used by the TUI.
 *
 * Scope is connect / first-response recovery only. Mid-stream body failures
 * still terminate the turn; the next user message can start a fresh request.
 */

const CONNECTION_FAILURE_PATTERNS = [
  /fetch failed/i,
  /SELF_SIGNED_CERT/i,
  /DEPTH_ZERO_SELF_SIGNED_CERT/i,
  /UNABLE_TO_VERIFY_LEAF_SIGNATURE/i,
  /SELF_SIGNED_CERT_IN_CHAIN/i,
  /CERT_HAS_EXPIRED/i,
  /ERR_CERT_/i,
  /ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN/i,
  /UND_ERR_|HeadersTimeoutError|ConnectTimeoutError|SocketError/i,
  // Bun/Node stream body drops during proxy/VPN jitter.
  /socket connection was closed unexpectedly/i,
  /connection closed unexpectedly/i,
  /socket hang up/i,
  /other side closed/i,
  /premature close/i,
  /network|connection reset|connection refused|temporarily unavailable/i,
  /stream interrupted/i,
];

/** One short backoff before a second connect attempt. */
export const DEFAULT_CONNECTION_RETRY_DELAYS_MS = [1_000] as const;
export const DEFAULT_CONNECTION_RETRY_JITTER_RATIO = 0.5;
/** Bound DNS / TLS / proxy cold start so hung sockets enter the retry loop. */
export const DEFAULT_CONNECT_TIMEOUT_MS = 20_000;

export interface RecoveringFetchOptions {
  readonly fetchImpl?: typeof globalThis.fetch;
  readonly retryDelaysMs?: readonly number[];
  readonly retryJitterRatio?: number;
  readonly randomImpl?: () => number;
  readonly waitImpl?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly connectTimeoutMs?: number;
  readonly scheduleTimeout?: (cb: () => void, ms: number) => () => void;
  readonly onRetry?: (info: {
    readonly attempt: number;
    readonly maxRetries: number;
    readonly delayMs: number;
    readonly reason: string;
  }) => void;
}

type ErrorLike = {
  readonly message?: unknown;
  readonly name?: unknown;
  readonly code?: unknown;
  readonly cause?: {
    readonly message?: unknown;
    readonly code?: unknown;
    readonly name?: unknown;
    readonly reason?: unknown;
  } | null;
};

function errorDetails(error: unknown): string {
  const value = error as ErrorLike | undefined;
  const parts: string[] = [];
  if (value?.message) parts.push(String(value.message));
  if (value?.name) parts.push(String(value.name));
  if (value?.code) parts.push(String(value.code));
  if (value?.cause?.message) parts.push(String(value.cause.message));
  if (value?.cause?.code) parts.push(String(value.cause.code));
  if (value?.cause?.name) parts.push(String(value.cause.name));
  if (value?.cause?.reason) parts.push(String(value.cause.reason));
  return parts.join(' ');
}

function createAbortError(): Error {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

function makeConnectTimeoutError(ms: number): Error {
  const error = new Error(`connect timeout after ${ms}ms (ConnectTimeoutError)`);
  (error as Error & { code?: string }).code = 'ConnectTimeoutError';
  return error;
}

function defaultScheduleTimeout(cb: () => void, ms: number): () => void {
  const timer = setTimeout(cb, ms);
  if (typeof (timer as { unref?: () => void }).unref === 'function') {
    (timer as { unref: () => void }).unref();
  }
  return () => clearTimeout(timer);
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw createAbortError();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (!signal) return;
    const onAbort = () => {
      clearTimeout(timer);
      reject(createAbortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function describeConnectionFailure(error: unknown): string {
  const value = error as ErrorLike | undefined;
  const message = value?.message ? String(value.message) : 'fetch failed';
  const causeCode = value?.cause?.code || value?.code || '';
  return causeCode ? `${message} (${String(causeCode)})` : message;
}

export function isRecoverableConnectionFailure(error: unknown): boolean {
  if ((error as ErrorLike | undefined)?.name === 'AbortError') return false;
  const text = errorDetails(error);
  return CONNECTION_FAILURE_PATTERNS.some((pattern) => pattern.test(text));
}

function applyJitter(delayMs: number, ratio: number, randomImpl: () => number): number {
  if (!(ratio > 0) || !(delayMs > 0)) return delayMs;
  const factor = 1 + Math.min(1, Math.max(0, ratio)) * randomImpl();
  return Math.round(delayMs * factor);
}

async function callWithConnectTimeout(
  fetchImpl: typeof globalThis.fetch,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  connectTimeoutMs: number,
  scheduleTimeout: (cb: () => void, ms: number) => () => void,
): Promise<Response> {
  if (!connectTimeoutMs || connectTimeoutMs <= 0) {
    return fetchImpl(input, init);
  }

  const controller = new AbortController();
  let timedOut = false;
  const cancelTimer = scheduleTimeout(() => {
    timedOut = true;
    controller.abort();
  }, connectTimeoutMs);
  const upstreamSignal = init?.signal;
  const onUpstreamAbort = () => controller.abort();
  if (upstreamSignal) {
    if (upstreamSignal.aborted) controller.abort();
    else upstreamSignal.addEventListener('abort', onUpstreamAbort, { once: true });
  }

  try {
    return await fetchImpl(input, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (timedOut) throw makeConnectTimeoutError(connectTimeoutMs);
    throw error;
  } finally {
    cancelTimer();
    if (upstreamSignal) upstreamSignal.removeEventListener('abort', onUpstreamAbort);
  }
}

/**
 * Retry a provider HTTP connect/request when the failure looks like network
 * jitter rather than an application/auth error.
 */
export async function fetchWithConnectionRecovery(
  input: RequestInfo | URL,
  init?: RequestInit,
  options: RecoveringFetchOptions = {},
): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const retryDelaysMs = options.retryDelaysMs ?? DEFAULT_CONNECTION_RETRY_DELAYS_MS;
  const retryJitterRatio = options.retryJitterRatio
    ?? (options.retryDelaysMs ? 0 : DEFAULT_CONNECTION_RETRY_JITTER_RATIO);
  const randomImpl = options.randomImpl ?? Math.random;
  const waitImpl = options.waitImpl ?? sleep;
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const scheduleTimeout = options.scheduleTimeout ?? defaultScheduleTimeout;
  const maxRetries = retryDelaysMs.length;
  let lastError: unknown;

  for (let round = 0; round <= maxRetries; round += 1) {
    if (init?.signal?.aborted) throw createAbortError();

    try {
      return await callWithConnectTimeout(
        fetchImpl,
        input,
        init,
        connectTimeoutMs,
        scheduleTimeout,
      );
    } catch (error) {
      lastError = error;
      if (!isRecoverableConnectionFailure(error) || round >= maxRetries) {
        throw error;
      }

      const baseDelay = retryDelaysMs[round] ?? 0;
      const delayMs = applyJitter(baseDelay, retryJitterRatio, randomImpl);
      options.onRetry?.({
        attempt: round + 1,
        maxRetries,
        delayMs,
        reason: describeConnectionFailure(error),
      });
      if (delayMs > 0) {
        await waitImpl(delayMs, init?.signal);
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

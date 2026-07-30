// Provider transport recovery: keep the same provider/model request, but retry
// transient connection failures before surfacing a terminal stream error.
//
// Desktop has one authoritative network stack: Electron net.fetch. It honors
// Chromium's system proxy and macOS trust store, so retries must stay on that
// same stack instead of falling through to raw Node fetch. Non-Electron hosts
// (the TUI compatibility path and focused unit tests) keep their injected fetch.

const CONNECTION_FAILURE_PATTERNS = [
  /fetch failed/i,
  /SELF_SIGNED_CERT/i,
  /DEPTH_ZERO_SELF_SIGNED_CERT/i,
  /UNABLE_TO_VERIFY_LEAF_SIGNATURE/i,
  /SELF_SIGNED_CERT_IN_CHAIN/i,
  /CERT_HAS_EXPIRED/i,
  /ERR_CERT_/i,
  /net::ERR_(?:FAILED|CONNECTION_|NETWORK_|INTERNET_|TIMED_OUT|TUNNEL_CONNECTION_FAILED|PROXY_CONNECTION_FAILED|SOCKS_CONNECTION_FAILED|NAME_NOT_RESOLVED|ADDRESS_UNREACHABLE|HTTP2_|QUIC_)/i,
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

// Retry a transient connection failure once after a short bounded delay. The
// actual default delay receives up to 50% positive jitter, which avoids clients
// reconnecting in lockstep while keeping recovery responsive.
export const DEFAULT_CONNECTION_RETRY_DELAYS_MS = [1_000];
export const DEFAULT_CONNECTION_RETRY_JITTER_RATIO = 0.5;

// Connect/first-response timeout guard. A socket that hangs during DNS / TLS /
// proxy cold start (returning neither headers nor an error) is aborted after
// this bound and surfaced as a recoverable ConnectTimeoutError, so it enters
// the backoff loop instead of blocking the turn forever.
export const DEFAULT_CONNECT_TIMEOUT_MS = 20_000;

function makeConnectTimeoutError(ms) {
  // Message includes "ConnectTimeoutError" so isRecoverableConnectionFailure
  // classifies it as a recoverable connection failure.
  const error = new Error(`connect timeout after ${ms}ms (ConnectTimeoutError)`);
  error.code = 'ConnectTimeoutError';
  return error;
}

function defaultScheduleTimeout(cb, ms) {
  const timer = setTimeout(cb, ms);
  if (timer?.unref) timer.unref();
  return () => clearTimeout(timer);
}

function errorDetails(error) {
  const parts = [];
  if (error?.message) parts.push(String(error.message));
  if (error?.code) parts.push(String(error.code));
  if (error?.cause?.message) parts.push(String(error.cause.message));
  if (error?.cause?.code) parts.push(String(error.cause.code));
  if (error?.cause?.reason) parts.push(String(error.cause.reason));
  return parts.join(' ');
}

function createAbortError() {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

function sleep(ms, signal) {
  if (signal?.aborted) return Promise.reject(createAbortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (!signal) return;
    const onAbort = () => {
      clearTimeout(timer);
      reject(createAbortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function describeConnectionFailure(error) {
  const message = error?.message || 'fetch failed';
  const causeCode = error?.cause?.code || error?.code || '';
  return causeCode ? `${message} (${causeCode})` : message;
}

export function isRecoverableConnectionFailure(error) {
  const text = errorDetails(error);
  return CONNECTION_FAILURE_PATTERNS.some((pattern) => pattern.test(text));
}

async function resolveElectronNetFetch() {
  try {
    const electron = await import('electron');
    const net = electron?.net || electron?.default?.net;
    return typeof net?.fetch === 'function' ? net.fetch.bind(net) : null;
  } catch {
    return null;
  }
}

function isElectronRuntime() {
  return Boolean(
    typeof process !== 'undefined'
    && process?.versions
    && process.versions.electron
  );
}

function electronTransportUnavailableError() {
  const error = new Error('electron net.fetch is unavailable in the Desktop main process');
  error.code = 'electron_net_fetch_unavailable';
  return error;
}

async function resolveProviderTransport({
  fetchImpl,
  electronFetchImpl,
  requireElectronTransport,
}) {
  const electronFetch = electronFetchImpl || await resolveElectronNetFetch();
  if (typeof electronFetch === 'function') {
    return {
      label: 'electron-net-fetch',
      fetch: electronFetch,
    };
  }
  if (requireElectronTransport) {
    throw electronTransportUnavailableError();
  }
  if (typeof fetchImpl === 'function') {
    return {
      label: 'non-electron-fetch',
      fetch: fetchImpl,
    };
  }
  throw new TypeError('provider fetch implementation is unavailable');
}

function emitConnectionRecovery(webContents, payload) {
  webContents?.send?.('chat:stream:connection-recovery', payload);
}

export async function fetchWithConnectionRecovery(url, init = {}, {
  webContents = null,
  streamId = null,
  provider = null,
  model = null,
  fetchImpl = globalThis.fetch,
  electronFetchImpl = null,
  requireElectronTransport = isElectronRuntime(),
  retryDelaysMs = DEFAULT_CONNECTION_RETRY_DELAYS_MS,
  retryJitterRatio = retryDelaysMs === DEFAULT_CONNECTION_RETRY_DELAYS_MS
    ? DEFAULT_CONNECTION_RETRY_JITTER_RATIO
    : 0,
  randomImpl = Math.random,
  waitImpl = sleep,
  connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
  scheduleTimeout = defaultScheduleTimeout,
  // Optional per-attempt request factory. Providers that stamp request_id into
  // the body/headers can rebuild a fresh payload on connection retries so the
  // server does not reject the recovery attempt as a duplicate request.
  buildInit = null,
} = {}) {
  const maxRetries = retryDelaysMs.length;
  let lastError = null;
  const baseInit = init || {};
  const transport = await resolveProviderTransport({
    fetchImpl,
    electronFetchImpl,
    requireElectronTransport,
  });

  const resolveAttemptInit = async (attempt) => {
    if (typeof buildInit !== 'function') return baseInit;
    const rebuilt = await buildInit({
      attempt,
      isRetry: attempt > 0,
      baseInit,
    });
    if (!rebuilt || typeof rebuilt !== 'object') return baseInit;
    return {
      ...baseInit,
      ...rebuilt,
      // Keep the caller-owned abort signal authoritative across rebuilds.
      signal: rebuilt.signal ?? baseInit.signal,
    };
  };

  // Guard the connect/first-response phase. fetch resolves once response headers
  // arrive, so racing this await bounds time-to-headers (connect + TLS + proxy),
  // not the streamed body. A hung socket is aborted and surfaced as a recoverable
  // ConnectTimeoutError so it enters the backoff loop instead of blocking forever.
  const callWithConnectTimeout = async (impl, attemptInit) => {
    if (!connectTimeoutMs || connectTimeoutMs <= 0) {
      return impl(url, attemptInit);
    }
    const controller = new AbortController();
    let timedOut = false;
    const cancelTimer = scheduleTimeout(() => {
      timedOut = true;
      controller.abort();
    }, connectTimeoutMs);
    const upstreamSignal = attemptInit?.signal;
    const onUpstreamAbort = () => controller.abort();
    if (upstreamSignal) {
      if (upstreamSignal.aborted) controller.abort();
      else upstreamSignal.addEventListener('abort', onUpstreamAbort, { once: true });
    }
    try {
      return await impl(url, { ...attemptInit, signal: controller.signal });
    } catch (error) {
      if (timedOut) throw makeConnectTimeoutError(connectTimeoutMs);
      throw error;
    } finally {
      cancelTimer();
      if (upstreamSignal) upstreamSignal.removeEventListener('abort', onUpstreamAbort);
    }
  };

  for (let round = 0; round <= maxRetries; round += 1) {
    if (baseInit?.signal?.aborted) throw createAbortError();
    const attemptInit = await resolveAttemptInit(round);

    try {
      const response = await callWithConnectTimeout(transport.fetch, attemptInit);
      if (round > 0) {
        emitConnectionRecovery(webContents, {
          streamId,
          provider,
          model,
          status: 'recovered',
          connection: transport.label,
          attempt: round,
          maxRetries,
          reason: lastError ? describeConnectionFailure(lastError) : null,
        });
      }
      return response;
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      if (!isRecoverableConnectionFailure(error)) throw error;
      lastError = error;
    }

    if (round >= maxRetries) break;
    const baseDelayMs = retryDelaysMs[round];
    const jitterMs = Math.floor(baseDelayMs * Math.max(0, retryJitterRatio) * randomImpl());
    const delayMs = baseDelayMs + jitterMs;
    emitConnectionRecovery(webContents, {
      streamId,
      provider,
      model,
      status: 'retrying',
      connection: transport.label,
      attempt: round + 1,
      maxRetries,
      delayMs,
      reason: describeConnectionFailure(lastError),
    });
    await waitImpl(delayMs, baseInit?.signal);
  }

  throw lastError;
}

// Provider transport recovery: keep the same provider/model request, but retry
// transient connection failures before surfacing a terminal stream error.

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
];

export const DEFAULT_CONNECTION_RETRY_DELAYS_MS = [
  10_000,
  10_000,
  10_000,
  10_000,
  10_000,
  30_000,
  30_000,
  30_000,
  30_000,
  30_000,
];

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
  retryDelaysMs = DEFAULT_CONNECTION_RETRY_DELAYS_MS,
  waitImpl = sleep,
} = {}) {
  const maxRetries = retryDelaysMs.length;
  let lastError = null;

  for (let round = 0; round <= maxRetries; round += 1) {
    if (init?.signal?.aborted) throw createAbortError();
    try {
      const response = await fetchImpl(url, init);
      if (round > 0) {
        emitConnectionRecovery(webContents, {
          streamId,
          provider,
          model,
          status: 'recovered',
          connection: 'node-fetch',
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

      const platformFetch = electronFetchImpl || await resolveElectronNetFetch();
      if (platformFetch) {
        try {
          const response = await platformFetch(url, init);
          emitConnectionRecovery(webContents, {
            streamId,
            provider,
            model,
            status: 'recovered',
            fromConnection: 'node-fetch',
            toConnection: 'electron-net-fetch',
            connection: 'electron-net-fetch',
            attempt: round,
            maxRetries,
            reason: describeConnectionFailure(error),
          });
          return response;
        } catch (fallbackError) {
          if (fallbackError?.name === 'AbortError') throw fallbackError;
          if (!isRecoverableConnectionFailure(fallbackError)) {
            const wrapped = new Error(
              `${describeConnectionFailure(error)}; electron_net_fetch_failed: ${describeConnectionFailure(fallbackError)}`
            );
            wrapped.cause = error;
            throw wrapped;
          }
          lastError = fallbackError;
        }
      }

      if (round >= maxRetries) break;
      const delayMs = retryDelaysMs[round];
      emitConnectionRecovery(webContents, {
        streamId,
        provider,
        model,
        status: 'retrying',
        attempt: round + 1,
        maxRetries,
        delayMs,
        reason: describeConnectionFailure(lastError),
      });
      await waitImpl(delayMs, init?.signal);
    }
  }

  throw lastError;
}

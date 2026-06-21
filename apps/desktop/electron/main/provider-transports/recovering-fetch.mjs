// Provider transport recovery: keep the same provider/model request, but retry
// transient connection failures before surfacing a terminal stream error.
//
// Channel selection: when a proxy is detected (corporate / system proxy), the
// Electron net.fetch transport is preferred first because it honors the OS proxy
// configuration, with Node fetch kept as fallback. Without a proxy we keep the
// original order (Node fetch first, Electron net.fetch as fallback).

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
  5_000,
  5_000,
  5_000,
  5_000,
  5_000,
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

function readEnvProxy(url, env) {
  let protocol = 'https:';
  try {
    protocol = new URL(url).protocol;
  } catch {
    protocol = 'https:';
  }
  const names = protocol === 'http:'
    ? ['HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']
    : ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy'];
  for (const name of names) {
    const value = env?.[name];
    if (value && String(value).trim()) return true;
  }
  return false;
}

async function resolveSystemProxy(url) {
  try {
    const electron = await import('electron');
    const session = electron?.session || electron?.default?.session;
    const resolver = session?.defaultSession?.resolveProxy;
    if (typeof resolver !== 'function') return false;
    const result = await session.defaultSession.resolveProxy(url);
    if (!result || typeof result !== 'string') return false;
    return !/^DIRECT/i.test(result.trim());
  } catch {
    return false;
  }
}

// Proxy detection seam: environment variables first, system proxy (Electron
// session.resolveProxy) as fallback. Returns false on any error so we safely
// fall back to the original Node-fetch-first behavior.
export async function defaultDetectProxy({
  url,
  env = (typeof process !== 'undefined' ? process.env : {}),
  resolveSystemProxyImpl = resolveSystemProxy,
} = {}) {
  if (readEnvProxy(url, env)) return true;
  try {
    return Boolean(await resolveSystemProxyImpl(url));
  } catch {
    return false;
  }
}

function channelFailLabel(label) {
  return label === 'electron-net-fetch' ? 'electron_net_fetch_failed' : 'node_fetch_failed';
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
  detectProxy = defaultDetectProxy,
} = {}) {
  const maxRetries = retryDelaysMs.length;
  let lastError = null;

  let proxyDetected = false;
  try {
    proxyDetected = Boolean(await detectProxy({ url, signal: init?.signal }));
  } catch {
    proxyDetected = false;
  }

  const nodeChannel = {
    label: 'node-fetch',
    resolve: async () => fetchImpl,
  };
  const electronChannel = {
    label: 'electron-net-fetch',
    resolve: async () => electronFetchImpl || await resolveElectronNetFetch(),
  };
  const [primaryChannel, secondaryChannel] = proxyDetected
    ? [electronChannel, nodeChannel]
    : [nodeChannel, electronChannel];

  for (let round = 0; round <= maxRetries; round += 1) {
    if (init?.signal?.aborted) throw createAbortError();

    let primaryError = null;
    const primaryImpl = await primaryChannel.resolve();
    if (primaryImpl) {
      try {
        const response = await primaryImpl(url, init);
        if (round > 0) {
          emitConnectionRecovery(webContents, {
            streamId,
            provider,
            model,
            status: 'recovered',
            connection: primaryChannel.label,
            attempt: round,
            maxRetries,
            reason: lastError ? describeConnectionFailure(lastError) : null,
          });
        }
        return response;
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
        if (!isRecoverableConnectionFailure(error)) throw error;
        primaryError = error;
        lastError = error;
      }
    }

    const secondaryImpl = await secondaryChannel.resolve();
    if (secondaryImpl) {
      try {
        const response = await secondaryImpl(url, init);
        emitConnectionRecovery(webContents, {
          streamId,
          provider,
          model,
          status: 'recovered',
          fromConnection: primaryChannel.label,
          toConnection: secondaryChannel.label,
          connection: secondaryChannel.label,
          attempt: round,
          maxRetries,
          reason: describeConnectionFailure(primaryError || lastError),
        });
        return response;
      } catch (fallbackError) {
        if (fallbackError?.name === 'AbortError') throw fallbackError;
        if (!isRecoverableConnectionFailure(fallbackError)) {
          const wrapped = new Error(
            `${describeConnectionFailure(primaryError || fallbackError)}; ${channelFailLabel(secondaryChannel.label)}: ${describeConnectionFailure(fallbackError)}`
          );
          wrapped.cause = primaryError || fallbackError;
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

  throw lastError;
}

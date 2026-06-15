// Provider transport recovery: keep the same provider/model request, but retry
// with a platform-native fetch implementation when Node's fetch cannot connect.

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

function errorDetails(error) {
  const parts = [];
  if (error?.message) parts.push(String(error.message));
  if (error?.code) parts.push(String(error.code));
  if (error?.cause?.message) parts.push(String(error.cause.message));
  if (error?.cause?.code) parts.push(String(error.cause.code));
  if (error?.cause?.reason) parts.push(String(error.cause.reason));
  return parts.join(' ');
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

export async function fetchWithConnectionRecovery(url, init = {}, {
  webContents = null,
  streamId = null,
  provider = null,
  model = null,
  fetchImpl = globalThis.fetch,
  electronFetchImpl = null,
} = {}) {
  try {
    return await fetchImpl(url, init);
  } catch (error) {
    if (!isRecoverableConnectionFailure(error)) throw error;

    const platformFetch = electronFetchImpl || await resolveElectronNetFetch();
    if (!platformFetch) throw error;

    const reason = describeConnectionFailure(error);
    let response;
    try {
      response = await platformFetch(url, init);
    } catch (fallbackError) {
      const wrapped = new Error(
        `${reason}; electron_net_fetch_failed: ${describeConnectionFailure(fallbackError)}`
      );
      wrapped.cause = error;
      throw wrapped;
    }

    webContents?.send?.('chat:stream:connection-recovery', {
      streamId,
      provider,
      model,
      fromConnection: 'node-fetch',
      toConnection: 'electron-net-fetch',
      reason,
    });
    return response;
  }
}

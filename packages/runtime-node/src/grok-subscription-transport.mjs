export const GROK_SUBSCRIPTION_BASE_URL = 'https://cli-chat-proxy.grok.com/v1';
export const GROK_STABLE_RELEASE_URL = 'https://x.ai/cli/stable';
export const GROK_SUBSCRIPTION_HEADERS = Object.freeze({
  'X-XAI-Token-Auth': 'xai-grok-cli',
  'x-grok-client-surface': 'grok-build',
});

export function buildGrokSubscriptionHeaders(accessToken, extra = {}) {
  return { ...extra, 'Content-Type': 'application/json',
    Authorization: `Bearer ${accessToken}`, ...GROK_SUBSCRIPTION_HEADERS };
}

function isSubscriptionRequest(url, init) {
  const target = new URL(url instanceof Request ? url.url : url);
  const headers = new Headers(init?.headers ?? (url instanceof Request ? url.headers : undefined));
  return target.origin === 'https://cli-chat-proxy.grok.com'
    && (target.pathname === '/v1' || target.pathname.startsWith('/v1/'))
    && headers.get('x-xai-token-auth') === 'xai-grok-cli'
    && headers.get('x-grok-client-surface') === 'grok-build';
}

function compatibilityError(code, message, cause) {
  return Object.assign(new Error(message, { cause }), { code });
}

function releaseVersion(text) {
  const version = String(text).trim();
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw compatibilityError('grok_release_invalid', 'Grok 官方兼容版本信息无效，请稍后重试。');
  // Major 1 uses the verified Responses/SSE contract. A future major requires
  // adapter review, rather than claiming support by copying its version header.
  if (match[1] !== '1') throw compatibilityError('grok_subscription_upgrade_required',
    'Grok 订阅接口已升级，请更新 Peer Agent 的协议适配后重试。');
  return version;
}

function waitForMetadata(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Shared host transport decorator: metadata uses the host's network stack,
 * never credentials. No CLI process, persistent cache or error-derived version. */
export function createGrokSubscriptionTransport({
  now = Date.now, cacheTtlMs = 6 * 60 * 60 * 1000,
  maxStaleMs = 24 * 60 * 60 * 1000, metadataTimeoutMs = 4000,
} = {}) {
  let cached = null;
  let pending = null;

  function discover(fetchImpl, force = false) {
    if (!force && cached && now() - cached.at < cacheTtlMs) return Promise.resolve(cached.version);
    if (pending) {
      if (!force || pending.force) return pending.promise;
      return pending.promise.catch(() => null).then(() => discover(fetchImpl, true));
    }
    const previous = cached;
    if (force) cached = null;
    const promise = Promise.resolve().then(async () => {
      try {
        const response = await fetchImpl(GROK_STABLE_RELEASE_URL, {
          headers: { Accept: 'text/plain' }, redirect: 'error',
          signal: AbortSignal.timeout(metadataTimeoutMs),
        });
        if (!response.ok) throw new Error(`grok_release_http_${response.status}`);
        const version = releaseVersion(await response.text());
        cached = { version, at: now() };
        return version;
      } catch (error) {
        if (error.code === 'grok_subscription_upgrade_required') throw error;
        if (!force && previous && now() - previous.at < maxStaleMs) return previous.version;
        throw compatibilityError('grok_compatibility_unavailable',
          '暂时无法确认 Grok 订阅接口的兼容信息，请稍后重试。', error);
      }
    });
    pending = { promise, force };
    const clear = () => { if (pending?.promise === promise) pending = null; };
    promise.then(clear, clear);
    return promise;
  }

  return {
    async fetch(fetchImpl, url, init = {}) {
      if (!isSubscriptionRequest(url, init)) return fetchImpl(url, init);
      const signal = init.signal ?? (url instanceof Request ? url.signal : undefined);
      signal?.throwIfAborted();
      const version = await waitForMetadata(discover(fetchImpl), signal);
      const send = value => {
        signal?.throwIfAborted();
        const headers = new Headers(init.headers ?? (url instanceof Request ? url.headers : undefined));
        headers.set('x-grok-client-version', value);
        return fetchImpl(url, { ...init, headers });
      };
      const response = await send(version);
      if (response.status !== 426) return response;
      // 426 rejects before inference. Refresh only the official release feed;
      // retry once only when it supplies a different supported version.
      const refreshed = await waitForMetadata(discover(fetchImpl, true), signal).catch(error => {
        if (signal?.aborted) throw error;
        return null;
      });
      if (!refreshed || refreshed === version) return response;
      await response.body?.cancel();
      return send(refreshed);
    },
  };
}

export const grokSubscriptionTransport = createGrokSubscriptionTransport();

export function formatGrokSubscriptionHttpError(status, text, headers) {
  if (status !== 426 || new Headers(headers).get('x-xai-token-auth') !== 'xai-grok-cli') return text;
  const minimum = /(?:update to|minimum) version (\d+\.\d+\.\d+)/i.exec(String(text))?.[1];
  return 'Grok 订阅接口与当前 Peer Agent 的协议适配不兼容，请更新 Peer Agent 后重试。'
    + (minimum ? `服务端要求兼容版本 ${minimum} 或更高。` : '');
}

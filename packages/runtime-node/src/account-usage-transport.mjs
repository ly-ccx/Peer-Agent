import { createHash } from 'node:crypto';

const MAX_BYTES = 256 * 1024;
const digest = (value) => createHash('sha256').update(value).digest('hex');
const failure = (status) => ({ success: false, status });

/** Private per-service cache; neither credentials nor remote error bodies escape. */
export function createAccountUsageTransport({ fetchImpl = globalThis.fetch, now = Date.now, ttlMs = 60_000, timeoutMs = 12_000 } = {}) {
  const cache = new Map();
  const pending = new Map();
  let generation = 0;
  return {
    clear() { generation++; cache.clear(); pending.clear(); },
    async query({ instanceId, channelId, baseUrl, allowedOrigins, allowedEndpointOrigins = allowedOrigins, endpoint, apiKey, force = false, method = 'GET', body, apiKeyHeaders = [], headers = {} }) {
      let target;
      let base;
      try {
        target = new URL(endpoint);
        base = new URL(baseUrl);
        if ([target, base].some((url) => url.protocol !== 'https:' || url.username || url.password)
          || !allowedOrigins.includes(base.origin) || !allowedEndpointOrigins.includes(target.origin)) {
          return failure('endpoint_not_supported');
        }
      } catch { return failure('endpoint_not_supported'); }
      if (typeof apiKey !== 'string' || !apiKey.trim()) return failure('missing_credential');
      if (!['GET', 'POST'].includes(method) || (body !== undefined && (method !== 'POST' || typeof body !== 'string' || Buffer.byteLength(body) > 4096))
        || apiKeyHeaders.some((name) => !['x-api-key', 'X-DashScope-API-Key'].includes(name))
        || Object.keys(headers).some((name) => !['Origin', 'Referer'].includes(name))) return failure('endpoint_not_supported');
      const key = digest(JSON.stringify([instanceId, channelId, base.href, target.href, apiKey, method, body, apiKeyHeaders, headers]));
      const cached = cache.get(key);
      if (!force && cached && now() - cached.at < ttlMs) return structuredClone(cached.result);
      if (pending.has(key)) return structuredClone(await pending.get(key));
      const epoch = generation;
      const work = (async () => {
        const controller = new AbortController();
        let timer;
        const deadline = new Promise((resolve) => {
          timer = setTimeout(() => { controller.abort(); resolve(failure('timeout')); }, timeoutMs);
        });
        const request = (async () => {
          try {
            const response = await fetchImpl(target.href, {
              method, body, redirect: 'error', signal: controller.signal,
              headers: { ...headers, ...Object.fromEntries(apiKeyHeaders.map((name) => [name, apiKey])), Authorization: `Bearer ${apiKey}`, Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
            });
            if (response.status >= 300 && response.status < 400) return failure('redirect_denied');
            if (!response.ok) return failure(response.status === 401 || response.status === 403 ? 'auth_required' : 'fetch_failed');
            if (Number(response.headers?.get('content-length')) > MAX_BYTES) return failure('response_too_large');
            const reader = response.body?.getReader();
            if (!reader) return failure('invalid_response');
            const chunks = [];
            let size = 0;
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                size += value.byteLength;
                if (size > MAX_BYTES) { await reader.cancel(); return failure('response_too_large'); }
                chunks.push(Buffer.from(value));
              }
            } finally { reader.releaseLock(); }
            const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (!data || typeof data !== 'object' || Array.isArray(data)) return failure('invalid_response');
            return { success: true, data, fetchedAt: now() };
          } catch { return failure(controller.signal.aborted ? 'timeout' : 'fetch_failed'); }
        })();
        try { return await Promise.race([request, deadline]); }
        finally { clearTimeout(timer); }
      })();
      pending.set(key, work);
      try {
        const result = await work;
        if (result.success && epoch === generation) {
          // Bounded memory even when users repeatedly rotate credentials.
          if (cache.size >= 100) cache.delete(cache.keys().next().value);
          cache.set(key, { at: now(), result });
        }
        return structuredClone(result);
      } finally { if (pending.get(key) === work) pending.delete(key); }
    },
  };
}

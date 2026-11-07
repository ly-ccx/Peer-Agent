/** HTTP diagnostics are bounded metadata, never arbitrary upstream output. */
const BODY_LIMIT = 64 * 1024;
const PROVIDER_CODES = new Set(['context_length_exceeded', 'context_window_exceeded', 'model_not_found', 'invalid_api_key', 'authentication_error', 'rate_limit_exceeded', 'insufficient_quota', 'invalid_request_error', 'configuration_error', 'server_error']);
const GATEWAY_CODES = new Set(['peer_request_messages_exceeded', 'peer_request_body_exceeded', 'peer_request_tools_exceeded', 'peer_request_invalid', 'peer_provider_context_exceeded']);
const LABELS = {
  context_length_exceeded: 'Context length exceeded', context_window_exceeded: 'Context window exceeded',
  model_not_found: 'The requested model does not exist', invalid_api_key: 'Authentication failed', authentication_error: 'Authentication failed',
  rate_limit_exceeded: 'Rate limit exceeded', insufficient_quota: 'Provider quota exhausted', invalid_request_error: 'Invalid request', configuration_error: 'Workspace model configuration is required', server_error: 'Provider server error',
  peer_request_messages_exceeded: 'Peer message count exceeds the gateway limit', peer_request_body_exceeded: 'Peer request body exceeds the gateway limit',
  peer_request_tools_exceeded: 'Peer tool definitions exceed the gateway limit', peer_request_invalid: 'Invalid Peer model request', peer_provider_context_exceeded: 'Provider context length exceeded',
};
export function safeProviderErrorLabel(code, actual, limit) {
  const label = LABELS[code];
  return label && Number.isSafeInteger(actual) && actual >= 0 && Number.isSafeInteger(limit) && limit >= 0
    ? `${label} (${actual}; limit ${limit})` : label;
}
function recognizedCode(value) {
  const text = typeof value === 'string' ? value.toLowerCase() : '';
  if (PROVIDER_CODES.has(text))
    return text;
  if (/^(?:bad request|invalid (?:peer model )?request)[.!]?$/.test(text)) return 'invalid_request_error';
  if (/^(?:configure a workspace model credential in settings|workspace model (?:credential storage|configuration) is unavailable)[.!]?$/.test(text)) return 'configuration_error';
  // Wording is used only for diagnostics, never to authorize replay.
  if (text.length < 1024 && /^(?:error: )?(?:context (?:length|window).*(?:exceed|limit|full)|maximum context length|prompt is too long)/i.test(text))
    return 'context_length_exceeded';
  if (/model.*(?:does not exist|not found)/i.test(text))
    return 'model_not_found';
  return undefined;
}
async function boundedText(response, { signal, timeoutMs = 1500, maxBytes = BODY_LIMIT }) {
  if (!response.body)
    return '';
  const reader = response.body.getReader();
  let timer, abortHandler;
  const stop = new Promise((resolve, reject) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
    abortHandler = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    if (signal?.aborted)
      abortHandler();
    else
      signal?.addEventListener('abort', abortHandler, { once: true });
  });
  try {
    const consume = async () => {
      const chunks = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done)
          return new TextDecoder().decode(Buffer.concat(chunks));
        size += value.byteLength;
        if (size > maxBytes)
          return null;
        chunks.push(value);
      }
    };
    return await Promise.race([consume(), stop]);
  }
  finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abortHandler);
    void reader.cancel().catch(() => { });
    try {
      reader.releaseLock();
    }
    catch { /* A timed-out read may still be settling. */ }
  }
}
export async function readProviderHttpError(response, options = {}) {
  const diagnostic = { status: response.status, source: 'provider', code: 'http_error' };
  const safeRequestId = (requestId) => {
    if (typeof requestId === 'string' && /^(?:[a-f0-9-]{8,64}|req_[a-zA-Z0-9]{1,64})$/.test(requestId)
        && !(options.secrets ?? []).some((secret) => secret && requestId.includes(secret))) diagnostic.requestId = requestId;
  };
  safeRequestId(response.headers.get('x-request-id'));
  let raw;
  try {
    raw = await boundedText(response, options);
  }
  catch (error) {
    if (options.signal?.aborted)
      throw error;
    return { diagnostic };
  }
  if (!raw || /<\s*(?:!doctype|html|body|head)\b/i.test(raw))
    return { diagnostic };
  let value;
  try {
    value = JSON.parse(raw);
  }
  catch {
    value = { message: raw };
  }
  if (!value || typeof value !== 'object')
    return { diagnostic };
  const nested = value.error && typeof value.error === 'object' ? value.error : {};
  const candidates = [nested.code, nested.type, value.code, value.type, nested.message, typeof value.error === 'string' ? value.error : undefined, value.message];
  const gateway = options.trustGatewayErrors === true && value.source === 'gateway_validation' && GATEWAY_CODES.has(value.code);
  let upstreamHost;
  try { upstreamHost = new URL(response.url).hostname; } catch { /* Synthetic/opaque responses have no trusted origin. */ }
  const zhipuCodes = upstreamHost === 'open.bigmodel.cn'
    ? new Map([['1113', 'insufficient_quota'], ['1261', 'context_length_exceeded']]) : new Map();
  const numericCode = [nested.code, value.code].map(code => zhipuCodes.get(code)).find(Boolean);
  const recognized = [numericCode, ...candidates.map(recognizedCode)].filter(Boolean);
  // Generic OpenAI error types must not hide an explicit context assertion.
  diagnostic.code = gateway ? value.code
    : recognized.find(code => code !== 'invalid_request_error') ?? recognized[0] ?? 'http_error';
  if (gateway) {
    diagnostic.source = 'gateway_validation';
    const details = value.details;
    if (details && typeof details === 'object') {
      for (const key of ['actual', 'limit'])
        if (Number.isSafeInteger(details[key]) && details[key] >= 0)
          diagnostic[key] = details[key];
      if (details.upstream_attempted === false)
        diagnostic.upstreamAttempted = false;
    }
  }
  if (options.trustGatewayErrors === true && value.source === 'provider' && Number.isInteger(value.upstream_status) && value.upstream_status >= 100 && value.upstream_status <= 599)
    diagnostic.upstreamStatus = value.upstream_status;
  safeRequestId(value.request_id ?? response.headers.get('x-request-id'));
  const detail = safeProviderErrorLabel(diagnostic.code, diagnostic.actual, diagnostic.limit);
  return { diagnostic, ...(detail ? { detail } : {}) };
}

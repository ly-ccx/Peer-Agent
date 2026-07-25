import {
  encodeAnthropicMessagesRequest,
  encodeGeminiGenerateContentRequest,
} from '../provider-encoders/index.mjs';

function cleanBaseUrl(value, fallback) {
  return String(value || fallback).replace(/\/+$/, '');
}

async function providerError(response) {
  const detail = await response.text().catch(() => '');
  const error = new Error(
    `context_count_failed:${response.status}${detail ? `:${detail}` : ''}`,
  );
  error.status = response.status;
  throw error;
}

/**
 * Anthropic exact-count Adapter. It derives the count payload from the same
 * encoder used by `/v1/messages`; only response-generation-only fields are
 * removed for `/v1/messages/count_tokens`.
 */
export async function countAnthropicCanonicalRequest({
  baseUrl,
  apiKey,
  headers,
  fetchImpl = globalThis.fetch,
  signal,
  ...request
} = {}) {
  const encoded = encodeAnthropicMessagesRequest(request);
  const {
    stream: _stream,
    max_tokens: _maxTokens,
    ...countBody
  } = encoded;
  const response = await fetchImpl(
    `${cleanBaseUrl(baseUrl, 'https://api.anthropic.com')}/v1/messages/count_tokens`,
    {
      method: 'POST',
      headers: headers || {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(countBody),
      signal,
    },
  );
  if (!response.ok) await providerError(response);
  const payload = await response.json();
  const inputTokens = Number(payload?.input_tokens);
  if (!Number.isFinite(inputTokens) || inputTokens < 0) {
    throw new Error('context_count_failed:invalid_anthropic_response');
  }
  return {
    inputTokens: Math.floor(inputTokens),
    source: 'provider_count_api',
  };
}

/**
 * Gemini API-key exact-count Adapter. OAuth Code Assist does not expose the
 * public `models.countTokens` contract, so callers must declare it as
 * observed-only instead of routing it here.
 */
export async function countGeminiCanonicalRequest({
  baseUrl,
  apiKey,
  headers,
  fetchImpl = globalThis.fetch,
  signal,
  model,
  ...request
} = {}) {
  const modelId = String(model || '').replace(/^models\//, '');
  const encoded = encodeGeminiGenerateContentRequest({
    ...request,
    model: modelId,
    authMethod: 'api_key',
  });
  const generateContentRequest = {
    model: `models/${modelId}`,
    ...encoded,
  };
  const endpoint = `${cleanBaseUrl(
    baseUrl,
    'https://generativelanguage.googleapis.com/v1beta',
  )}/models/${modelId}:countTokens`;
  const url = apiKey
    ? `${endpoint}${endpoint.includes('?') ? '&' : '?'}key=${encodeURIComponent(apiKey)}`
    : endpoint;
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: headers || { 'Content-Type': 'application/json' },
    body: JSON.stringify({ generateContentRequest }),
    signal,
  });
  if (!response.ok) await providerError(response);
  const payload = await response.json();
  const inputTokens = Number(payload?.totalTokens);
  if (!Number.isFinite(inputTokens) || inputTokens < 0) {
    throw new Error('context_count_failed:invalid_gemini_response');
  }
  return {
    inputTokens: Math.floor(inputTokens),
    source: 'provider_count_api',
  };
}

export function contextCountCapabilityForProvider(input = {}) {
  const provider = String(input.provider || input.providerId || '').toLowerCase();
  if (provider.includes('anthropic')) return { kind: 'provider_count_api' };
  if (provider.includes('gemini') && input.authMethod === 'api_key') {
    return { kind: 'provider_count_api' };
  }
  return { kind: 'observed_usage_only' };
}

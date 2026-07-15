export const GROK_BUILD_BASE_URL = 'https://cli-chat-proxy.grok.com/v1';
export const GROK_BUILD_DEFAULT_MODEL = 'grok-4.5';
export const GROK_BUILD_CLIENT_VERSION = '0.1.202';

const FALLBACK_MODELS = [
  {
    id: GROK_BUILD_DEFAULT_MODEL,
    label: 'Grok 4.5',
    contextWindow: 500_000,
    supportsTools: true,
    supportsVision: true,
    supportsReasoning: true,
    reasoningEffortLevels: ['low', 'medium', 'high'],
    defaultReasoningEffort: 'high',
  },
];

export function buildGrokBuildHeaders(accessToken, extra = {}) {
  return {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'X-XAI-Token-Auth': 'xai-grok-cli',
    'x-grok-client-surface': 'grok-build',
    'x-grok-client-version': GROK_BUILD_CLIENT_VERSION,
    ...extra,
  };
}

function toModel(item) {
  const id = typeof item?.id === 'string' ? item.id.trim() : '';
  if (!id) return null;
  const contextWindow = Number(item.context_window ?? item.context_length ?? item.max_context_length);
  const reasoningLevels = Array.isArray(item.supported_reasoning_efforts)
    ? item.supported_reasoning_efforts.filter((value) => typeof value === 'string')
    : undefined;
  return {
    id,
    label: typeof item.display_name === 'string' && item.display_name.trim() ? item.display_name.trim() : id,
    contextWindow: Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : undefined,
    supportsTools: item.supports_tools !== false,
    supportsVision: item.supports_vision !== false,
    supportsReasoning: item.supports_reasoning !== false,
    reasoningEffortLevels: reasoningLevels?.length ? reasoningLevels : undefined,
    defaultReasoningEffort: typeof item.default_reasoning_effort === 'string' ? item.default_reasoning_effort : undefined,
  };
}

export async function listGrokBuildModels(accessToken, {
  fetchImpl = fetch,
  baseUrl = GROK_BUILD_BASE_URL,
} = {}) {
  const endpoint = `${String(baseUrl).replace(/\/+$/, '')}/models`;
  try {
    const response = await fetchImpl(endpoint, {
      headers: buildGrokBuildHeaders(accessToken),
    });
    if (!response.ok) throw new Error(`grok_models_http_${response.status}`);
    const json = await response.json();
    const rows = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : [];
    const models = rows.map(toModel).filter(Boolean);
    if (!models.length) throw new Error('grok_models_empty');
    return { models, source: 'remote' };
  } catch (error) {
    return {
      models: FALLBACK_MODELS.map((model) => ({ ...model })),
      source: 'builtin',
      error: error?.message || 'grok_models_failed',
    };
  }
}

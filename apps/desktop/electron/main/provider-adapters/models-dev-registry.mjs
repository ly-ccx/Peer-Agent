const MODELS_DEV_URL = 'https://models.dev/api.json';
const DEFAULT_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 5000;

let cachedRegistry = null;
let cachedAt = 0;
let pendingRegistry = null;

function finiteNumber(value) {
  const number = typeof value === 'number' ? value : Number.NaN;
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function normalizeModelId(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeModelsDevEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const id = normalizeModelId(entry.id);
  if (!id) return null;

  const inputModalities = Array.isArray(entry.modalities?.input)
    ? entry.modalities.input.map((item) => String(item).toLowerCase())
    : [];

  return {
    id,
    label: typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : id,
    contextWindow: finiteNumber(entry.limit?.context),
    maxOutputTokens: finiteNumber(entry.limit?.output),
    supportsVision: inputModalities.includes('image'),
    supportsReasoning: typeof entry.reasoning === 'boolean' ? entry.reasoning : undefined,
    inputPrice: finiteNumber(entry.cost?.input),
    outputPrice: finiteNumber(entry.cost?.output),
    cacheReadPrice: finiteNumber(entry.cost?.cache_read),
    cacheWritePrice: finiteNumber(entry.cost?.cache_write),
  };
}

function buildModelsDevIndex(data) {
  const index = new Map();
  if (!data || typeof data !== 'object') return index;

  for (const provider of Object.values(data)) {
    if (!provider || typeof provider !== 'object' || !provider.models || typeof provider.models !== 'object') continue;
    for (const [key, rawEntry] of Object.entries(provider.models)) {
      const entry = normalizeModelsDevEntry(rawEntry);
      if (!entry) continue;
      // models.dev may expose the same exact model ID under several providers.
      // Keep the first registry entry for deterministic, exact-ID enrichment.
      if (!index.has(entry.id)) index.set(entry.id, entry);
      const keyedId = normalizeModelId(key);
      if (keyedId && !index.has(keyedId)) index.set(keyedId, entry);
    }
  }
  return index;
}

async function fetchModelsDevRegistry({
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  now = Date.now,
} = {}) {
  const timestamp = now();
  if (cachedRegistry && timestamp - cachedAt < cacheTtlMs) return cachedRegistry;
  if (pendingRegistry) return pendingRegistry;
  if (typeof fetchImpl !== 'function') return cachedRegistry;

  pendingRegistry = (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(MODELS_DEV_URL, {
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`models.dev registry failed: HTTP ${response.status}`);
      const registry = buildModelsDevIndex(await response.json());
      cachedRegistry = registry;
      cachedAt = now();
      return registry;
    } catch {
      // Enrichment is optional: preserve a stale registry when available, otherwise
      // return an empty index so the provider's own catalog remains fully usable.
      return cachedRegistry ?? new Map();
    } finally {
      clearTimeout(timeout);
      pendingRegistry = null;
    }
  })();

  return pendingRegistry;
}

function mergeDefinedFallback(primary, fallback) {
  const merged = { ...primary };
  for (const [key, value] of Object.entries(fallback ?? {})) {
    if (merged[key] === undefined && value !== undefined) merged[key] = value;
  }
  return merged;
}

function enrichModelsWithRegistry(models, registry) {
  return models.map((model) => {
    const metadata = registry.get(model.id);
    if (!metadata) return model;
    const providerHasMetadata = model.metadataSource === 'provider';
    const providerHasPricing = model.pricingSource === 'provider';
    return {
      ...mergeDefinedFallback(model, metadata),
      metadataSource: providerHasMetadata ? 'provider' : 'models.dev',
      pricingSource: providerHasPricing
        ? 'provider'
        : ([metadata.inputPrice, metadata.outputPrice, metadata.cacheReadPrice, metadata.cacheWritePrice]
          .some((value) => value !== undefined)
          ? 'models.dev-reference'
          : undefined),
    };
  });
}

function resetModelsDevRegistryCacheForTests() {
  cachedRegistry = null;
  cachedAt = 0;
  pendingRegistry = null;
}

export {
  MODELS_DEV_URL,
  DEFAULT_CACHE_TTL_MS,
  buildModelsDevIndex,
  enrichModelsWithRegistry,
  fetchModelsDevRegistry,
  normalizeModelsDevEntry,
  resetModelsDevRegistryCacheForTests,
};

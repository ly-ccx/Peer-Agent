import { fetchWithConnectionRecovery } from '../provider-transports/recovering-fetch.mjs';

const MODELS_DEV_URL = 'https://models.dev/api.json';
const DEFAULT_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 5000;

const PRICING_FIELDS = [
  'inputPrice',
  'outputPrice',
  'cacheReadPrice',
  'cacheWritePrice',
];

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

/** Lowercase alphanumerics only — bridges gpt-5.4 / gpt5.4 / GPT_5_4 style ids. */
function canonicalizeModelId(value) {
  const normalized = normalizeModelId(value).toLowerCase();
  if (!normalized) return '';
  return normalized.replace(/[^a-z0-9]+/g, '');
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

function indexEntry(index, key, entry) {
  const exact = normalizeModelId(key);
  if (exact && !index.has(exact)) index.set(exact, entry);
  const canonical = canonicalizeModelId(key);
  if (canonical && !index.has(canonical)) index.set(canonical, entry);
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
      indexEntry(index, entry.id, entry);
      indexEntry(index, key, entry);
    }
  }
  return index;
}

function lookupModelsDevMetadata(registry, modelId) {
  if (!registry || typeof registry.get !== 'function') return undefined;
  const exact = normalizeModelId(modelId);
  if (!exact) return undefined;
  if (registry.has(exact)) return registry.get(exact);
  const canonical = canonicalizeModelId(exact);
  if (canonical && registry.has(canonical)) return registry.get(canonical);
  return undefined;
}

async function fetchModelsDevRegistry({
  fetchImpl = fetchWithConnectionRecovery,
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

function hasAnyPricing(source) {
  return PRICING_FIELDS.some((field) => source?.[field] !== undefined);
}

function resolvePricingSource(model, metadata, providerHasPricing) {
  if (providerHasPricing) return 'provider';
  if (hasAnyPricing(model) || hasAnyPricing(metadata)) return 'models.dev-reference';
  return undefined;
}

function enrichModelsWithRegistry(models, registry) {
  return models.map((model) => {
    const modelId = model?.id ?? model?.model;
    const metadata = lookupModelsDevMetadata(registry, modelId);
    if (!metadata) return model;
    const providerHasMetadata = model.metadataSource === 'provider';
    const providerHasPricing = model.pricingSource === 'provider';
    const merged = mergeDefinedFallback(model, metadata);
    return {
      ...merged,
      metadataSource: providerHasMetadata ? 'provider' : 'models.dev',
      pricingSource: resolvePricingSource(merged, metadata, providerHasPricing),
    };
  });
}

/**
 * Fill missing price fields on a saved provider/model record from models.dev.
 * Never overwrites existing finite prices (user-written or previously filled).
 * Returns { item, changed }.
 */
function fillMissingPricingFromRegistry(item, registry) {
  if (!item || typeof item !== 'object') return { item, changed: false };
  const modelId = item.model ?? item.id;
  const metadata = lookupModelsDevMetadata(registry, modelId);
  if (!metadata) return { item, changed: false };

  // Do not clobber prices the user explicitly marked as provider-owned.
  if (item.pricingSource === 'provider') return { item, changed: false };

  // Some provider adapters explicitly own cache semantics and remove unsupported
  // cache prices while normalizing their catalog records. Do not reintroduce those
  // fields from the reference registry or read -> backfill will never be idempotent.
  const skipCacheWrite = item.authMethod === 'oauth_chatgpt';
  const skipCachePricing = item.channelId === 'qoder' || item.authMethod === 'qoder_local_auth';

  let changed = false;
  const next = { ...item };
  for (const field of PRICING_FIELDS) {
    if (skipCachePricing && (field === 'cacheReadPrice' || field === 'cacheWritePrice')) continue;
    if (skipCacheWrite && field === 'cacheWritePrice') continue;
    if (next[field] === undefined && metadata[field] !== undefined) {
      next[field] = metadata[field];
      changed = true;
    }
  }

  if (!changed) return { item, changed: false };

  if (!next.pricingSource) next.pricingSource = 'models.dev-reference';
  if (!next.metadataSource) next.metadataSource = 'models.dev';
  next.metadataSyncedAt = new Date().toISOString();
  return { item: next, changed: true };
}

function resetModelsDevRegistryCacheForTests() {
  cachedRegistry = null;
  cachedAt = 0;
  pendingRegistry = null;
}

export {
  MODELS_DEV_URL,
  DEFAULT_CACHE_TTL_MS,
  PRICING_FIELDS,
  buildModelsDevIndex,
  canonicalizeModelId,
  enrichModelsWithRegistry,
  fetchModelsDevRegistry,
  fillMissingPricingFromRegistry,
  lookupModelsDevMetadata,
  normalizeModelsDevEntry,
  resetModelsDevRegistryCacheForTests,
};

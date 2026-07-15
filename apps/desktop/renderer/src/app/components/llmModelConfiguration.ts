import type {
  LlmModelInfo,
  LlmModelListResult,
  LlmProviderConfigView,
  LlmReasoningEffortMap,
} from '@peer-agent/protocol';

export type ModelMetadataSource = NonNullable<LlmProviderConfigView['metadataSource']>;

export interface ModelCatalogEntry {
  readonly model: LlmModelInfo;
  readonly configured: boolean;
}

const meaningfulLabel = (model: LlmModelInfo): string | undefined => {
  const label = model.label?.trim();
  return label && label !== model.id ? label : undefined;
};

export function modelMetadataPatch(
  model: LlmModelInfo,
  source: ModelMetadataSource,
  syncedAt = new Date().toISOString(),
): Record<string, unknown> {
  const patch: Record<string, unknown> = {
    metadataSource: source,
    metadataSyncedAt: syncedAt,
  };
  const label = meaningfulLabel(model);
  if (label) patch.modelLabel = label;
  if (typeof model.contextWindow === 'number') patch.contextWindow = model.contextWindow;
  if (typeof model.maxOutputTokens === 'number') patch.maxOutputTokens = model.maxOutputTokens;
  if (typeof model.inputPrice === 'number') patch.inputPrice = model.inputPrice;
  if (typeof model.outputPrice === 'number') patch.outputPrice = model.outputPrice;
  if (typeof model.cacheReadPrice === 'number') patch.cacheReadPrice = model.cacheReadPrice;
  if (typeof model.supportsVision === 'boolean') patch.supportsVision = model.supportsVision;
  if (typeof model.supportsReasoning === 'boolean') patch.supportsReasoning = model.supportsReasoning;
  return patch;
}

export function metadataSourceFromList(result: Pick<LlmModelListResult, 'source'>): ModelMetadataSource {
  switch (result.source) {
    case 'builtin': return 'builtin';
    case 'local': return 'local';
    case 'remote':
    case 'fallback':
    default:
      return 'remote';
  }
}

export interface ModelImportPatch extends Record<string, unknown> {
  readonly model: string;
  readonly metadataSource: ModelMetadataSource;
  readonly metadataSyncedAt: string;
}

/**
 * Turn a catalog selection into stable model-record patches.
 *
 * The catalog is advisory: duplicate/blank IDs are ignored and fields omitted by
 * the source stay omitted, so importing a sparse remote record never invents or
 * clears model metadata.
 */
export function buildModelImportPatches(
  models: readonly LlmModelInfo[],
  source: ModelMetadataSource,
  syncedAt = new Date().toISOString(),
): readonly ModelImportPatch[] {
  const seen = new Set<string>();
  const patches: ModelImportPatch[] = [];
  for (const candidate of models) {
    const model = candidate.id?.trim();
    if (!model || seen.has(model)) continue;
    seen.add(model);
    patches.push({
      model,
      ...modelMetadataPatch({ ...candidate, id: model }, source, syncedAt),
    } as ModelImportPatch);
  }
  return patches;
}

export function buildModelCatalog(
  models: readonly LlmModelInfo[],
  configuredModels: readonly Pick<LlmProviderConfigView, 'model'>[],
): readonly ModelCatalogEntry[] {
  const configured = new Set(configuredModels.map((item) => item.model));
  const deduped = new Map<string, LlmModelInfo>();
  for (const model of models) {
    const id = model.id?.trim();
    if (!id || deduped.has(id)) continue;
    deduped.set(id, { ...model, id, label: model.label?.trim() || id });
  }
  return [...deduped.values()].map((model) => ({ model, configured: configured.has(model.id) }));
}

export function formatReasoningEffortMap(map: LlmReasoningEffortMap | undefined): string {
  return map ? JSON.stringify(map, null, 2) : '';
}

export function parseReasoningEffortMap(text: string): LlmReasoningEffortMap | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const parsed: Record<string, string | number> = {};
  const assign = (key: string, value: unknown) => {
    const name = String(key || '').trim();
    if (!name) return;
    if (typeof value === 'number' && Number.isFinite(value)) {
      parsed[name] = value;
      return;
    }
    if (typeof value === 'string' && value.trim()) {
      const raw = value.trim();
      const asNumber = Number(raw);
      parsed[name] = Number.isFinite(asNumber) && /^-?\d+(\.\d+)?$/.test(raw) ? asNumber : raw;
    }
  };
  try {
    const value = JSON.parse(trimmed) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('reasoning_effort_map_invalid');
    for (const [key, item] of Object.entries(value)) assign(key, item);
  } catch (error) {
    if (error instanceof Error && error.message === 'reasoning_effort_map_invalid') throw error;
    for (const rawLine of trimmed.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      const equalIndex = line.indexOf('=');
      const colonIndex = line.indexOf(':');
      const idx = equalIndex > 0 ? equalIndex : colonIndex;
      if (idx <= 0) throw new Error('reasoning_effort_map_invalid');
      assign(line.slice(0, idx), line.slice(idx + 1));
    }
  }
  if (Object.keys(parsed).length === 0) throw new Error('reasoning_effort_map_invalid');
  return parsed as LlmReasoningEffortMap;
}

export function filterModelCatalog(
  entries: readonly ModelCatalogEntry[],
  query: string,
): readonly ModelCatalogEntry[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return entries;
  return entries.filter(({ model }) => `${model.label} ${model.id}`.toLocaleLowerCase().includes(needle));
}

export function modelMetadataCompletion(
  model: Pick<LlmProviderConfigView, 'contextWindow' | 'maxOutputTokens' | 'inputPrice' | 'outputPrice' | 'supportsVision' | 'supportsReasoning' | 'supportsPromptCaching'>,
): 'complete' | 'partial' | 'missing' {
  const core = [model.contextWindow, model.maxOutputTokens];
  const prices = [model.inputPrice, model.outputPrice];
  const hasCore = core.every((value) => typeof value === 'number' && value > 0);
  const hasPrices = prices.every((value) => typeof value === 'number' && value >= 0);
  if (hasCore && hasPrices) return 'complete';
  const capabilityValues = [
    model.supportsVision,
    model.supportsReasoning,
    model.supportsPromptCaching,
  ];
  if (core.some((value) => typeof value === 'number' && value > 0)
    || prices.some((value) => typeof value === 'number' && value >= 0)
    || capabilityValues.some((value) => typeof value === 'boolean')) return 'partial';
  return 'missing';
}

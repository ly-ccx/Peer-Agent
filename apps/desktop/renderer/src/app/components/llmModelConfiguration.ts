import {
  resolveLlmModelOptionValues,
  type LlmModelInfo,
  type LlmModelListResult,
  type LlmModelOptionDefinition,
  type LlmModelOptionValues,
  type LlmProviderConfigView,
  type LlmReasoningEffortMap,
} from '@peer-agent/protocol';

export type ModelMetadataSource = NonNullable<LlmProviderConfigView['metadataSource']>;

export interface ModelCatalogEntry {
  readonly model: LlmModelInfo;
  readonly configured: boolean;
}

export function contextWindowDefinition(model: Pick<LlmModelInfo, 'modelOptions'>) {
  return model.modelOptions?.find((definition) => definition.choices.some((choice) => (
    typeof choice.contextWindow === 'number' && choice.contextWindow > 0
  )));
}

export function selectedModelContextWindow(
  model: Pick<LlmProviderConfigView, 'contextWindow' | 'modelOptions' | 'modelOptionValues'>,
): number | undefined {
  const definition = contextWindowDefinition(model);
  if (!definition) return model.contextWindow;
  const values = resolveLlmModelOptionValues(model.modelOptions, model.modelOptionValues);
  const selected = definition.choices.find((choice) => choice.value === values[definition.id]);
  return selected?.contextWindow ?? model.contextWindow;
}

export function modelContextWindowRange(
  model: Pick<LlmModelInfo, 'contextWindow' | 'modelOptions'>,
): { readonly defaultContextWindow?: number; readonly maxContextWindow?: number } {
  const definition = contextWindowDefinition(model);
  const windows = definition?.choices
    .map((choice) => choice.contextWindow)
    .filter((value): value is number => typeof value === 'number' && value > 0) ?? [];
  if (!definition || windows.length === 0) {
    return { defaultContextWindow: model.contextWindow, maxContextWindow: model.contextWindow };
  }
  const defaultChoice = definition.choices.find((choice) => choice.value === definition.defaultValue);
  return {
    defaultContextWindow: defaultChoice?.contextWindow ?? model.contextWindow,
    maxContextWindow: Math.max(...windows),
  };
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
  const enrichedByModelsDev = model.metadataSource === 'models.dev';
  const patch: Record<string, unknown> = {
    metadataSource: enrichedByModelsDev ? 'models.dev' : source,
    metadataSyncedAt: syncedAt,
  };
  if (model.pricingSource) patch.pricingSource = model.pricingSource;
  const label = meaningfulLabel(model);
  if (label) patch.modelLabel = label;
  if (typeof model.contextWindow === 'number') patch.contextWindow = model.contextWindow;
  if (typeof model.maxOutputTokens === 'number') patch.maxOutputTokens = model.maxOutputTokens;
  if (typeof model.inputPrice === 'number') patch.inputPrice = model.inputPrice;
  if (typeof model.outputPrice === 'number') patch.outputPrice = model.outputPrice;
  if (typeof model.cacheReadPrice === 'number') patch.cacheReadPrice = model.cacheReadPrice;
  if (typeof model.cacheWritePrice === 'number') patch.cacheWritePrice = model.cacheWritePrice;
  if (typeof model.supportsVision === 'boolean') patch.supportsVision = model.supportsVision;
  if (typeof model.supportsReasoning === 'boolean') patch.supportsReasoning = model.supportsReasoning;
  if (model.modelOptions) patch.modelOptions = model.modelOptions;
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

export interface ModelSelectionChanges {
  readonly additions: readonly LlmModelInfo[];
  readonly updates: readonly { readonly configured: LlmProviderConfigView; readonly model: LlmModelInfo }[];
  readonly removals: readonly LlmProviderConfigView[];
}

function metadataValueEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left === undefined || right === undefined) return false;
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Return true when importing a catalog entry would change stored model metadata. */
export function modelCatalogMetadataDiffers(
  model: LlmModelInfo,
  configured: LlmProviderConfigView,
): boolean {
  const comparable: Record<string, unknown> = {};
  const label = meaningfulLabel(model);
  if (label) comparable.modelLabel = label;
  if (model.pricingSource) comparable.pricingSource = model.pricingSource;
  if (typeof model.contextWindow === 'number') comparable.contextWindow = model.contextWindow;
  if (typeof model.maxOutputTokens === 'number') comparable.maxOutputTokens = model.maxOutputTokens;
  if (typeof model.inputPrice === 'number') comparable.inputPrice = model.inputPrice;
  if (typeof model.outputPrice === 'number') comparable.outputPrice = model.outputPrice;
  if (typeof model.cacheReadPrice === 'number') comparable.cacheReadPrice = model.cacheReadPrice;
  if (typeof model.cacheWritePrice === 'number') comparable.cacheWritePrice = model.cacheWritePrice;
  if (typeof model.supportsVision === 'boolean') comparable.supportsVision = model.supportsVision;
  if (typeof model.supportsReasoning === 'boolean') comparable.supportsReasoning = model.supportsReasoning;
  if (model.modelOptions) comparable.modelOptions = model.modelOptions;
  return Object.entries(comparable).some(([key, value]) => (
    !metadataValueEqual(configured[key as keyof LlmProviderConfigView], value)
  ));
}

/** Compare the complete catalog selection with the models currently stored in a provider group. */
export function calculateModelSelectionChanges(
  selectedModels: readonly LlmModelInfo[],
  configuredModels: readonly LlmProviderConfigView[],
): ModelSelectionChanges {
  const selectedById = new Map<string, LlmModelInfo>();
  for (const candidate of selectedModels) {
    const id = candidate.id?.trim();
    if (!id || selectedById.has(id)) continue;
    selectedById.set(id, { ...candidate, id });
  }
  const configuredIds = new Set(configuredModels.map((item) => item.model));
  return {
    additions: [...selectedById.values()].filter((model) => !configuredIds.has(model.id)),
    updates: configuredModels.flatMap((configured) => {
      const model = selectedById.get(configured.model);
      return model && modelCatalogMetadataDiffers(model, configured) ? [{ configured, model }] : [];
    }),
    removals: configuredModels.filter((item) => !selectedById.has(item.model)),
  };
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

export function updateModelOptionSelection(
  definitions: readonly LlmModelOptionDefinition[] | undefined,
  values: LlmModelOptionValues | undefined,
  definitionId: string,
  serializedValue: string,
): LlmModelOptionValues {
  const resolved = resolveLlmModelOptionValues(definitions, values);
  const definition = definitions?.find((candidate) => candidate.id === definitionId);
  const choice = definition?.choices.find((candidate) => String(candidate.value) === serializedValue);
  if (!definition || !choice) return resolved;
  return { ...resolved, [definition.id]: choice.value };
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

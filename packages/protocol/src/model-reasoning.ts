/** Provider-declared effort values. Unknown capabilities do not create UI choices. */
export type ModelReasoningEffort = 'off' | 'low' | 'medium' | 'default' | 'high' | 'xhigh' | 'max';
const ORDER: readonly ModelReasoningEffort[] = ['off', 'low', 'medium', 'default', 'high', 'xhigh', 'max'];

export function isModelReasoningEffort(value: unknown): value is ModelReasoningEffort {
  return ORDER.includes(value as ModelReasoningEffort);
}

export function modelReasoningLevels(provider: {
  readonly supportsReasoning?: unknown;
  readonly reasoningEffortLevels?: unknown;
  readonly reasoningEffortMap?: unknown;
}): readonly ModelReasoningEffort[] {
  if (provider.supportsReasoning === false) return [];
  if (Array.isArray(provider.reasoningEffortLevels)) {
    const declared = provider.reasoningEffortLevels;
    return ORDER.filter(value => declared.includes(value));
  }
  if (provider.reasoningEffortMap && typeof provider.reasoningEffortMap === 'object' && !Array.isArray(provider.reasoningEffortMap)) {
    const keys = Object.keys(provider.reasoningEffortMap as Record<string, unknown>);
    return ORDER.filter(value => keys.includes(value));
  }
  return [];
}

export function modelDefaultReasoningEffort(provider: {
  readonly supportsReasoning?: unknown;
  readonly reasoningEffortLevels?: unknown;
  readonly reasoningEffortMap?: unknown;
  readonly reasoningEffort?: unknown;
  readonly reasoningDefaultEffort?: unknown;
  readonly defaultEffort?: unknown;
}): ModelReasoningEffort | undefined {
  const levels = modelReasoningLevels(provider);
  for (const value of [provider.reasoningEffort, provider.reasoningDefaultEffort, provider.defaultEffort, 'default', 'medium', 'high', 'low', ...levels]) {
    if (isModelReasoningEffort(value) && levels.includes(value)) return value;
  }
  return undefined;
}

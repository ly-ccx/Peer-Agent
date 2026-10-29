/** Provider-declared effort values. Unknown capabilities do not create UI choices. */
export type ModelReasoningEffort = 'off' | 'low' | 'medium' | 'default' | 'high' | 'xhigh' | 'max';
const ORDER: readonly ModelReasoningEffort[] = ['off', 'low', 'medium', 'default', 'high', 'xhigh', 'max'];

export function isModelReasoningEffort(value: unknown): value is ModelReasoningEffort {
  return ORDER.includes(value as ModelReasoningEffort);
}

export function modelReasoningLevels(provider: {
  readonly supportsReasoning?: unknown;
  readonly reasoningEffortLevels?: unknown;
}): readonly ModelReasoningEffort[] {
  if (provider.supportsReasoning === false || !Array.isArray(provider.reasoningEffortLevels)) return [];
  const declared = provider.reasoningEffortLevels;
  return ORDER.filter(value => declared.includes(value));
}

export function modelDefaultReasoningEffort(provider: {
  readonly supportsReasoning?: unknown;
  readonly reasoningEffortLevels?: unknown;
  readonly reasoningEffort?: unknown;
  readonly defaultEffort?: unknown;
}): ModelReasoningEffort | undefined {
  const levels = modelReasoningLevels(provider);
  for (const value of [provider.reasoningEffort, provider.defaultEffort, 'default', 'medium', 'high', 'low', ...levels]) {
    if (isModelReasoningEffort(value) && levels.includes(value)) return value;
  }
  return undefined;
}

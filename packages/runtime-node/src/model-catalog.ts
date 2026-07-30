export type ModelReasoningEffort = 'off' | 'low' | 'medium' | 'default' | 'high' | 'xhigh' | 'max';

export type RuntimePermissionPolicy = 'read-only' | 'ask' | 'workspace-write' | 'custom';

export interface RuntimeModelCatalogEntry {
  readonly providerId: string;
  readonly modelId: string;
  /**
   * Desktop model entry id (llm-providers.json v2 models[].id). Desktop binds
   * conversations by this id, so cross-end binding resolution needs it to map
   * back to the groupId-keyed providerId.
   */
  readonly entryId?: string;
  readonly displayName: string;
  readonly contextWindow?: number;
  readonly supportsTools: boolean;
  readonly supportedReasoningEfforts: readonly ModelReasoningEffort[];
  readonly defaultReasoningEffort: ModelReasoningEffort;
  readonly available: boolean;
  readonly unavailableReason?: string;
}

export interface RuntimeModelSelection {
  readonly providerId: string;
  readonly modelId: string;
  readonly reasoningEffort: ModelReasoningEffort;
}

export function normalizeModelReasoningEffort(
  entry: RuntimeModelCatalogEntry,
  requested: ModelReasoningEffort | undefined,
): ModelReasoningEffort {
  const effort = requested ?? entry.defaultReasoningEffort;
  return entry.supportedReasoningEfforts.includes(effort)
    ? effort
    : entry.defaultReasoningEffort;
}

export function isRuntimeModelSelectionAvailable(
  catalog: readonly RuntimeModelCatalogEntry[],
  selection: RuntimeModelSelection,
): boolean {
  const entry = catalog.find((candidate) => (
    candidate.providerId === selection.providerId && candidate.modelId === selection.modelId
  ));
  return Boolean(
    entry?.available && entry.supportedReasoningEfforts.includes(selection.reasoningEffort),
  );
}

export const RUNTIME_PERMISSION_POLICIES: readonly RuntimePermissionPolicy[] = Object.freeze([
  'read-only',
  'ask',
  'workspace-write',
  'custom',
]);

export function normalizeRuntimePermissionPolicy(
  value: string | null | undefined,
): RuntimePermissionPolicy {
  return RUNTIME_PERMISSION_POLICIES.includes(value as RuntimePermissionPolicy)
    ? value as RuntimePermissionPolicy
    : 'ask';
}

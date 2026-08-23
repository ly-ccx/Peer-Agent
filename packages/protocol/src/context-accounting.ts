export type ContextCountCapability =
  | { readonly kind: 'provider_count_api' }
  | { readonly kind: 'provider_tokenizer'; readonly tokenizerVersion: string }
  | { readonly kind: 'observed_usage_only' }
  | { readonly kind: 'unavailable' };

export type ContextAccountingPhase =
  | 'request_preflight'
  | 'stream_preview'
  | 'tool_result'
  | 'post_compaction'
  | 'turn_complete'
  | 'restored'
  | 'model_changed';

export type ContextAccountingPressureSource =
  | 'provider_usage'
  | 'provider_count_api'
  | 'provider_tokenizer'
  | 'provider_error_evidence'
  | 'unknown';

/**
 * Canonical cross-host model identity used by context accounting.
 *
 * Desktop persists a credential/provider id and model separately. Older TUI
 * builds persisted `${providerId}::${modelId}` in the provider-id field. This
 * normalizer makes both shapes converge without treating a host migration as a
 * model change.
 */
export function contextAccountingModelKey(
  providerId: string | null | undefined,
  modelId: string | null | undefined,
): string {
  const provider = typeof providerId === 'string' && providerId.trim()
    ? providerId.trim()
    : 'unknown-provider';
  const model = typeof modelId === 'string' && modelId.trim()
    ? modelId.trim()
    : '';
  const separator = provider.lastIndexOf('::');
  const baseProvider = separator > 0 ? provider.slice(0, separator) : provider;
  const embeddedModel = separator > 0 ? provider.slice(separator + 2) : '';
  const resolvedModel = model || embeddedModel;
  return resolvedModel ? `${baseProvider}::${resolvedModel}` : baseProvider;
}

export interface ContextAccountingObserved {
  readonly inputTokens: number;
  readonly requestFingerprint: string;
  readonly compactionEpoch: number;
  readonly source: 'provider_usage';
  readonly observedAt: number;
  readonly supersededByCompactionRevision?: number;
}
export interface ContextAccountingCounted {
  readonly inputTokens: number;
  readonly requestFingerprint: string;
  readonly compactionEpoch: number;
  readonly source: 'provider_count_api' | 'provider_tokenizer';
  readonly countedAt: number;
}

export interface ContextOverflowEvidence {
  readonly requestedTokens?: number;
  readonly maximumTokens?: number;
  readonly status?: number;
  readonly message: string;
}

export interface ContextCountVerification {
  readonly requestFingerprint: string;
  readonly countedInputTokens: number;
  readonly observedInputTokens: number;
  readonly absoluteDelta: number;
  readonly relativeDelta: number;
  readonly tolerance: number;
  readonly status: 'verified' | 'drift';
  readonly verifiedAt: number;
}

/**
 * Presentation composition of the last built provider request.
 *
 * Occupancy authority stays on `authoritativeInputTokens` / `percent`.
 * This breakdown never invents a percentage; hosts may scale category
 * estimates so they sum to the authoritative total.
 */
export const CONTEXT_USAGE_CATEGORY_IDS = [
  'system_prompt',
  'tool_definitions',
  'rules',
  'skills',
  'mcp_tools',
  'subagents',
  'summarized_conversation',
  'conversation',
] as const;

export type ContextUsageCategoryId = (typeof CONTEXT_USAGE_CATEGORY_IDS)[number];

export type ContextUsageBreakdownQuality = 'projected' | 'scaled';

export interface ContextUsageCategory {
  readonly id: ContextUsageCategoryId;
  readonly tokens: number;
}

export interface ContextUsageBreakdown {
  readonly version: 1;
  readonly quality: ContextUsageBreakdownQuality;
  readonly categories: readonly ContextUsageCategory[];
  readonly estimatedTokens: number;
}

const CONTEXT_USAGE_CATEGORY_ID_SET = new Set<string>(CONTEXT_USAGE_CATEGORY_IDS);

function finitePositiveTokens(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null;
}

/** Drop invalid persisted breakdowns instead of letting them become occupancy truth. */
export function normalizeContextUsageBreakdown(
  value: unknown,
): ContextUsageBreakdown | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (record.version !== 1) return null;
  if (record.quality !== 'projected' && record.quality !== 'scaled') return null;
  if (!Array.isArray(record.categories)) return null;
  const categories: ContextUsageCategory[] = [];
  for (const item of record.categories) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    if (typeof row.id !== 'string' || !CONTEXT_USAGE_CATEGORY_ID_SET.has(row.id)) continue;
    const tokens = finitePositiveTokens(row.tokens);
    if (tokens == null) continue;
    categories.push({ id: row.id as ContextUsageCategoryId, tokens });
  }
  const estimatedTokens = finitePositiveTokens(record.estimatedTokens);
  if (categories.length === 0 || estimatedTokens == null) return null;
  return {
    version: 1,
    quality: record.quality,
    categories,
    estimatedTokens,
  };
}

/**
 * The only cross-host context-capacity state.
 *
 * Numeric occupancy is present only when it is backed by provider usage,
 * provider-aligned exact count, or provider overflow evidence. Pending draft,
 * stream, and tool changes are represented as pending state and character
 * counts; they never become a fabricated token percentage.
 */
export interface ContextAccountingSnapshot {
  readonly version: 1;
  readonly conversationId: string;
  readonly contentRevision: number;
  readonly modelKey: string;
  readonly revision: number;
  readonly phase: ContextAccountingPhase;
  readonly compactionEpoch: number;
  readonly contextWindow: number | null;
  readonly inputBudget: number | null;
  readonly compactionThresholdTokens: number | null;
  readonly authoritativeInputTokens: number | null;
  readonly percent: number | null;
  readonly pressureSource: ContextAccountingPressureSource;
  readonly pendingUncountedChanges: boolean;
  readonly pendingContentChars: number;
  readonly countCapability: ContextCountCapability;
  readonly counterStatus: 'active' | 'degraded';
  readonly updatedAt: number;
  readonly lastObserved?: ContextAccountingObserved;
  readonly nextCounted?: ContextAccountingCounted;
  readonly lastOverflow?: ContextOverflowEvidence;
  readonly verification?: ContextCountVerification;
  /** Presentation-only request composition. Never occupancy authority. */
  readonly usageBreakdown?: ContextUsageBreakdown;
}

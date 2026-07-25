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
}

/**
 * Usage scopes are deliberately explicit because the same token fields have
 * different meanings at each runtime boundary.
 */
export type UsageScope =
  | 'provider_request'
  | 'runtime_turn'
  | 'conversation_lifetime';

export interface UsageAmounts {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

/** Capacity truth for one canonical request sent to a provider. */
export interface ProviderRequestUsage extends UsageAmounts {
  readonly usageScope: 'provider_request';
  readonly requestIndex: number;
  readonly requestPurpose: 'agent' | 'compaction_summary';
  readonly requestFingerprint?: string;
}

/** Billable sum of every provider request executed by one user/runtime turn. */
export interface RuntimeTurnUsage extends UsageAmounts {
  readonly usageScope: 'runtime_turn';
  readonly providerRequestCount: number;
}

/** Durable billable sum across completed runtime turns in one conversation. */
export interface ConversationLifetimeUsage extends UsageAmounts {
  readonly usageScope: 'conversation_lifetime';
  readonly runtimeTurnCount?: number;
}

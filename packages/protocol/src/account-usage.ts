/** Account observations never contain credentials or raw provider responses. */
export type AccountUsageSource = 'api_key' | 'oauth' | 'cli' | 'local';
export type AccountUsageScope = 'account' | 'organization' | 'subscription' | 'api_key' | 'local_only';

export interface AccountUsageBalance {
  readonly currency: string;
  /** Decimal strings preserve the provider's monetary precision. */
  readonly total: string;
  readonly paid?: string;
  readonly granted?: string;
  readonly source: AccountUsageSource;
  readonly scope: AccountUsageScope;
}

export interface AccountUsageSpend {
  readonly period: 'today' | 'week' | 'month' | 'total';
  readonly amount: string;
  readonly currency: string;
  readonly source: AccountUsageSource;
  readonly scope: AccountUsageScope;
}

export interface AccountUsageUnavailable {
  readonly dimension: 'balance' | 'windows' | 'spend';
  readonly reason: string;
  readonly requiredAuth?: 'admin_key' | 'web_session' | 'cli_login' | 'oauth' | 'coding_plan_key';
}

/** Only retained requests through Peer Agent, never the vendor's account ledger. */
export interface AccountUsageLocal {
  readonly source: 'local';
  readonly scope: 'local_only';
  readonly requests: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly estimatedCostUsd?: number;
  readonly from?: string;
  readonly to?: string;
  readonly note: string;
}

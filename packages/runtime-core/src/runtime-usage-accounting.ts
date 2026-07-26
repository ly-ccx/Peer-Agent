import type {
  ProviderRequestUsage,
  RuntimeTurnUsage,
  UsageAmounts,
} from '@peer-agent/protocol';

export type ProviderUsageInput = Readonly<{
  [Key in keyof UsageAmounts]?: number | null;
}> | null | undefined;

export interface RuntimeUsageAccountingSnapshot {
  readonly providerRequestCount: number;
  readonly lastRequest: ProviderRequestUsage | null;
  readonly turnTotal: RuntimeTurnUsage;
}

export interface RuntimeUsageAccounting {
  observeProviderRequest(
    usage?: ProviderUsageInput,
    metadata?: {
      readonly requestFingerprint?: string;
      readonly requestPurpose?: 'agent' | 'compaction_summary';
      /** Auxiliary requests are billable but must not replace context truth. */
      readonly capacityBearing?: boolean;
    },
  ): RuntimeUsageAccountingSnapshot;
  snapshot(): RuntimeUsageAccountingSnapshot;
}

function token(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
}

function normalizeUsage(usage: Exclude<ProviderUsageInput, null | undefined>): UsageAmounts {
  const inputTokens = token(usage.inputTokens);
  const outputTokens = token(usage.outputTokens);
  const cacheReadTokens = token(usage.cacheReadTokens);
  const cacheWriteTokens = token(usage.cacheWriteTokens);
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    // Provider `totalTokens` is not canonical: some APIs include cached input
    // there while exposing cache separately. Peer adapters normalize cache as
    // disjoint dimensions, so this sum is stable across providers.
    totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
  };
}

function hasUsage(usage: UsageAmounts): boolean {
  return usage.inputTokens > 0
    || usage.outputTokens > 0
    || usage.cacheReadTokens > 0
    || usage.cacheWriteTokens > 0
    || usage.totalTokens > 0;
}

export function createRuntimeUsageAccounting(): RuntimeUsageAccounting {
  let providerRequestCount = 0;
  let lastRequest: ProviderRequestUsage | null = null;
  let totals: UsageAmounts = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
  };

  function snapshot(): RuntimeUsageAccountingSnapshot {
    return {
      providerRequestCount,
      lastRequest: lastRequest ? { ...lastRequest } : null,
      turnTotal: {
        usageScope: 'runtime_turn',
        providerRequestCount,
        ...totals,
      },
    };
  }

  return {
    observeProviderRequest(usage, metadata = {}) {
      providerRequestCount += 1;
      if (usage) {
        const normalized = normalizeUsage(usage);
        if (hasUsage(normalized)) {
          const request: ProviderRequestUsage = {
            usageScope: 'provider_request',
            requestIndex: providerRequestCount,
            requestPurpose: metadata.requestPurpose ?? 'agent',
            ...(metadata.requestFingerprint
              ? { requestFingerprint: metadata.requestFingerprint }
              : {}),
            ...normalized,
          };
          if (metadata.capacityBearing !== false) lastRequest = request;
          totals = {
            inputTokens: totals.inputTokens + normalized.inputTokens,
            outputTokens: totals.outputTokens + normalized.outputTokens,
            cacheReadTokens: totals.cacheReadTokens + normalized.cacheReadTokens,
            cacheWriteTokens: totals.cacheWriteTokens + normalized.cacheWriteTokens,
            totalTokens: totals.totalTokens + normalized.totalTokens,
          };
        }
      }
      return snapshot();
    },
    snapshot,
  };
}

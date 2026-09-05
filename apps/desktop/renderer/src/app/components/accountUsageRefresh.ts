import type { LlmSubscriptionQuota } from '@peer-agent/protocol';

/** An IPC failure is not a new vendor observation. Never advance fetchedAt. */
export function accountUsageRefreshFailed(previous?: LlmSubscriptionQuota, revision = previous?.accountUsageRevision): LlmSubscriptionQuota {
  if (previous?.accountUsageRevision !== revision) previous = undefined;
  return {
    ...previous,
    accountUsageRevision: revision,
    success: false,
    status: 'fetch_failed',
    stale: Boolean(previous?.fetchedAt || previous?.balances?.length || previous?.windows?.length),
    error: undefined,
  };
}

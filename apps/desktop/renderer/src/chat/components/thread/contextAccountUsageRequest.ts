import type { LlmProviderConfigView, LlmSubscriptionQuota } from '@peer-agent/protocol';
import { currentAccountUsage } from '../../../app/components/accountUsageIdentity.ts';
import { accountUsageRefreshFailed } from '../../../app/components/accountUsageRefresh.ts';

export interface ContextAccountUsageState {
  quota?: LlmSubscriptionQuota;
  loading: boolean;
}

/** One mounted account identity. dispose invalidates all outstanding observations. */
export function createContextAccountUsageRequest(
  provider: LlmProviderConfigView,
  fetchQuota: (input: { id: string; force: boolean }) => Promise<LlmSubscriptionQuota>,
  publish: (state: ContextAccountUsageState) => void,
) {
  let generation = 0;
  let disposed = false;
  let quota: LlmSubscriptionQuota | undefined;
  return {
    async load(force = false) {
      if (disposed) return;
      const ticket = ++generation;
      publish({ quota, loading: true });
      try {
        const result = await fetchQuota({ id: provider.id, force });
        if (disposed || ticket !== generation) return;
        quota = currentAccountUsage(result, provider);
      } catch {
        if (disposed || ticket !== generation) return;
        quota = accountUsageRefreshFailed(quota, provider.accountUsageRevision);
      }
      publish({ quota, loading: false });
    },
    dispose() { disposed = true; generation += 1; },
  };
}

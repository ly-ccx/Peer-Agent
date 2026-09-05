import type { LlmProviderConfigView } from '@peer-agent/protocol';
import { useEffect, useRef, useState } from 'react';
import { contextAccountUsageSummary } from './contextAccountUsageSummary';
import { clientApi } from '../../../clientApi';
import { createContextAccountUsageRequest, type ContextAccountUsageState } from './contextAccountUsageRequest';

/** Mounted only inside the open panel, keyed by account identity by its caller. */
export function ContextAccountUsage({ provider, isZh }: { provider: LlmProviderConfigView; isZh: boolean }) {
  const [state, setState] = useState<ContextAccountUsageState>({ loading: true });
  const request = useRef<ReturnType<typeof createContextAccountUsageRequest> | null>(null);
  useEffect(() => {
    const controller = createContextAccountUsageRequest(provider,
      (input) => clientApi.llmGetSubscriptionQuota(input), setState);
    request.current = controller;
    // Each panel open requests a fresh observation rather than the client cache.
    void controller.load(true);
    return () => { controller.dispose(); request.current = null; };
  }, [provider]);
  return <div className="ctx-usage-panel-notes" role="status" aria-busy={state.loading}>
    {contextAccountUsageSummary(state.quota, state.loading, isZh).map((line, index) => <p key={index}>{line}</p>)}
  </div>;
}

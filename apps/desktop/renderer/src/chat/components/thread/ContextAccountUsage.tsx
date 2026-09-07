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
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const refresh = () => setNow(Date.now());
    const timer = window.setInterval(refresh, 30_000);
    window.addEventListener('focus', refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, []);
  return <div className="ctx-usage-panel-notes" role="status" aria-busy={state.loading}>
    {contextAccountUsageSummary(state.quota, state.loading, isZh, now).map((line, index) => <p key={index}>{line}</p>)}
  </div>;
}

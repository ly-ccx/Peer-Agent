import { useState } from 'react';
import type { I18nRuntime } from '@peer-agent/i18n';
import { clientApi } from '../../clientApi';

export function BotHostControl({ workspaceId, i18n }: { workspaceId: string; i18n: I18nRuntime }) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<'requested' | 'ready' | 'failed' | ''>('');
  async function takeOver() {
    setBusy(true); setStatus('');
    try {
      const result = await clientApi.projectAgentTakeoverHost({ workspaceId });
      setStatus(result.ok ? result.requested ? 'requested' : 'ready' : 'failed');
    } catch { setStatus('failed'); }
    finally { setBusy(false); }
  }
  return <section className="bot-host-control">
    <span>{i18n.t('projectAgent.host.title')}</span>
    <p className="bot-drawer-note">{i18n.t('projectAgent.host.hint')}</p>
    <button className="bot-host-action" type="button" disabled={busy} onClick={() => { void takeOver(); }}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
        <path d="M4 8h15m-4-4 4 4-4 4M20 16H5m4-4-4 4 4 4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {i18n.t('projectAgent.host.action')}
    </button>
    {status ? <p className="bot-drawer-note" role="status">{i18n.t(`projectAgent.host.${status}`)}</p> : null}
  </section>;
}

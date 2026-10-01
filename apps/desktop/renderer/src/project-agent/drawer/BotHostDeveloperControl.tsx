import { useEffect, useState } from 'react';
import type { I18nRuntime } from '@peer-agent/i18n';
import type { BotListItem } from '@peer-agent/protocol';
import { clientApi } from '../../clientApi';
import { Dropdown } from '../../app/components/Dropdown';
import { BotHostControl } from './BotHostControl';

export function BotHostDeveloperControl({ i18n }: { i18n: I18nRuntime }) {
  const [bots, setBots] = useState<readonly BotListItem[]>([]);
  const [workspaceId, setWorkspaceId] = useState('');
  useEffect(() => {
    let live = true;
    void clientApi.projectAgentList().then(result => {
      if (live && result.ok) { setBots(result.items ?? []); setWorkspaceId(result.items?.[0]?.workspaceId ?? ''); }
    }).catch(() => {});
    return () => { live = false; };
  }, []);
  if (!bots.length) return null;
  return <section className="settings-card">
    <Dropdown value={workspaceId} onChange={setWorkspaceId} ariaLabel={i18n.t('projectAgent.host.title')}
      options={bots.map(bot => ({ value: bot.workspaceId, label: bot.profile.displayName }))} />
    <BotHostControl key={workspaceId} workspaceId={workspaceId} i18n={i18n} />
  </section>;
}

import type { I18nRuntime } from '@peer-agent/i18n';
import { Dropdown } from '../app/components/Dropdown';
import { ACCESS_LEVELS, accessLevelLabel, accessLevelTitle, isLocalAccessLevel } from '../chat/state/preferences';
import { PeerIcon } from '../ui/icons';
import { useBotAccessPolicy } from './state/useBotAccessPolicy';
import './styles/bot-access-control.css';

const ACCESS_ICONS = { ask_before_local: 'hand', session_local: 'terminal', full_local: 'shieldAlert', restricted_local: 'hand' } as const;

export function BotAccessControl({ workspaceId, i18n, onSavingChange }: { readonly workspaceId: string; readonly i18n: I18nRuntime; readonly onSavingChange: (saving: boolean) => void }) {
  const access = useBotAccessPolicy({ workspaceId });
  const isZh = i18n.locale.startsWith('zh');
  return <div className="bot-access-control" aria-busy={access.busy}>
    <Dropdown className="composer-dropdown bot-access-picker" value={access.view?.policy?.accessLevel ?? ''}
      triggerLabel={access.view?.policy ? accessLevelLabel(access.view.policy.accessLevel, isZh) : undefined}
      prefix={access.view?.policy ? <PeerIcon name={ACCESS_ICONS[access.view.policy.accessLevel]} size={16} strokeWidth={1.75} /> : undefined}
      menuLabel={i18n.t('projectAgent.access.label')}
      options={ACCESS_LEVELS.map(level => ({ value: level, label: accessLevelLabel(level, isZh),
        description: accessLevelTitle(level, isZh), icon: <PeerIcon name={ACCESS_ICONS[level]} size={20} strokeWidth={1.75} />,
        tone: level === 'full_local' ? 'danger' : undefined }))}
      placeholder={i18n.t('projectAgent.access.loading')}
      disabled={access.loading || access.busy || !access.view?.policy}
      ariaLabel={i18n.t('projectAgent.access.label')} title={i18n.t('projectAgent.access.scope')} menuPlacement="up"
      onChange={level => {
        if (!isLocalAccessLevel(level)) return;
        onSavingChange(true);
        void Promise.resolve(access.save(level)).finally(() => onSavingChange(false));
      }} />
    {access.error ? <button type="button" className="bot-access-retry" role="alert" title={i18n.t('projectAgent.access.failed')}
      onClick={() => void access.refresh()}>{i18n.t('projectAgent.access.retry')}</button> : null}
  </div>;
}

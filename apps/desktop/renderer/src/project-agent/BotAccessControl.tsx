import type { I18nRuntime } from '@peer-agent/i18n';
import { Dropdown } from '../app/components/Dropdown';
import { ACCESS_LEVELS, accessLevelLabel, isLocalAccessLevel } from '../chat/state/preferences';
import { useBotAccessPolicy } from './state/useBotAccessPolicy';
import './styles/bot-access-control.css';

export function BotAccessControl({ workspaceId, i18n, onSavingChange }: { readonly workspaceId: string; readonly i18n: I18nRuntime; readonly onSavingChange: (saving: boolean) => void }) {
  const access = useBotAccessPolicy({ workspaceId });
  const isZh = i18n.locale.startsWith('zh');
  return <div className="bot-access-control" aria-busy={access.busy}>
    <Dropdown className="composer-dropdown bot-access-picker" value={access.view?.policy?.accessLevel ?? ''}
      triggerLabel={access.view?.policy ? accessLevelLabel(access.view.policy.accessLevel, isZh) : undefined}
      options={ACCESS_LEVELS.map(level => ({ value: level, label: accessLevelLabel(level, isZh), tone: level === 'full_local' ? 'danger' : undefined }))}
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

import type { I18nRuntime } from '@peer-agent/i18n';
import { useId } from 'react';
import { Switch } from '../../../ui/boolean-controls';
import { useDeveloperFlag } from '../../state/useDeveloperFlag';
import './developer-panel.css';

export function DeveloperPanel({ i18n }: { readonly i18n: I18nRuntime }) {
  const flag = useDeveloperFlag();
  const switchLabelId = useId();
  if (flag.enabled == null && !flag.error) {
    return (
      <div className="settings-panel developer-panel">
        <p className="settings-status">{i18n.t('settings.usage.loading')}</p>
      </div>
    );
  }
  const enabled = flag.enabled === true;
  return (
    <div className="settings-panel developer-panel">
      <header className="developer-panel__header">
        <h2>{i18n.t('developer.projectAgent.title')}</h2>
        <p>{i18n.t('developer.projectAgent.description')}</p>
      </header>
      {flag.error ? <p className="settings-warning">{i18n.t(flag.error === 'load' ? 'developer.loadFailed' : 'developer.saveFailed')}</p> : null}
      <section className="settings-card">
        <div className="developer-panel__row">
          <h3 id={switchLabelId}>{i18n.t('developer.projectAgent.switch')}</h3>
          <Switch
            checked={enabled}
            aria-labelledby={switchLabelId}
            onCheckedChange={(checked) => void flag.setProjectAgentMode(checked)}
          />
        </div>
      </section>
      <section className="settings-card">
        <h3>{i18n.t('developer.projectAgent.diagnostics')}</h3>
        <p className="developer-panel__status">
          {i18n.t(enabled ? 'developer.projectAgent.active' : 'developer.projectAgent.inactive')}
        </p>
      </section>
    </div>
  );
}

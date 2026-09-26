import type { I18nRuntime } from '@peer-agent/i18n';
import { useDeveloperFlag } from '../../state/useDeveloperFlag';

export function DeveloperPanel({ i18n }: { readonly i18n: I18nRuntime }) {
  const flag = useDeveloperFlag();
  if (flag.enabled == null && !flag.error) {
    return <p className="settings-status">{i18n.t('settings.usage.loading')}</p>;
  }
  return (
    <div className="settings-panel">
      <header className="settings-panel__header">
        <h2>{i18n.t('developer.projectAgent.title')}</h2>
        <p>{i18n.t('developer.projectAgent.description')}</p>
      </header>
      {flag.error ? <p className="settings-warning">{i18n.t(flag.error === 'load' ? 'developer.loadFailed' : 'developer.saveFailed')}</p> : null}
      <section className="settings-card">
        <label>
          <input
            type="checkbox"
            checked={flag.enabled === true}
            onChange={(event) => void flag.setProjectAgentMode(event.target.checked)}
          />
          {i18n.t('developer.projectAgent.switch')}
        </label>
      </section>
      <section className="settings-card">
        <h3>{i18n.t('developer.projectAgent.diagnostics')}</h3>
        <p className="settings-status">{i18n.t('developer.projectAgent.inactive')}</p>
      </section>
    </div>
  );
}

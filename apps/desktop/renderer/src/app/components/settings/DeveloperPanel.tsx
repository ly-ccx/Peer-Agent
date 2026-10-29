import { BotHostDeveloperControl } from '../../../project-agent/drawer/BotHostDeveloperControl';
import { ProjectDiagnosticsPanel } from '../../../project-agent/diagnostics/ProjectDiagnosticsPanel';
import type { I18nRuntime } from '@peer-agent/i18n';

export function DeveloperPanel({ i18n }: { readonly i18n: I18nRuntime }) {
  return (
    <div className="settings-panel">
      <header className="settings-panel__header">
        <h2>{i18n.t('developer.projectAgent.title')}</h2>
        <p>{i18n.t('developer.projectAgent.description')}</p>
      </header>
      <BotHostDeveloperControl i18n={i18n} />
      <ProjectDiagnosticsPanel i18n={i18n} />
    </div>
  );
}

import type { I18nRuntime } from '@zeus-atlas/i18n';
import type { AuthState } from '@zeus-atlas/protocol';
import { useState } from 'react';
import { DeveloperSettingsPanel } from '../../../app/components/DeveloperSettingsPanel';
import { GeneralSettingsSection } from './GeneralSettingsSection';

type SettingsSection = 'general' | 'developer';

export function SettingsView({
  authState,
  i18n,
  onBack,
  onDeveloperSettingsChanged,
  onLocaleChanged,
}: {
  readonly authState: AuthState | null;
  readonly i18n: I18nRuntime;
  readonly onBack: () => void;
  readonly onDeveloperSettingsChanged: () => Promise<void> | void;
  readonly onLocaleChanged?: () => Promise<void> | void;
}) {
  const [activeSection, setActiveSection] = useState<SettingsSection>('general');

  return (
    <section className="settings-view">
      <header className="settings-view-header">
        <button type="button" onClick={onBack}>
          ← {i18n.t('settings.backToChat')}
        </button>
      </header>
      <div className="settings-view-body">
        <nav className="settings-nav">
          <button
            type="button"
            className={activeSection === 'general' ? 'active' : ''}
            onClick={() => setActiveSection('general')}
          >
            {i18n.t('settings.general')}
          </button>
          <button
            type="button"
            className={activeSection === 'developer' ? 'active' : ''}
            onClick={() => setActiveSection('developer')}
          >
            {i18n.t('developer.title')}
          </button>
        </nav>
        <div className="settings-content">
          {activeSection === 'general' ? (
            <GeneralSettingsSection
              i18n={i18n}
              onLocaleChanged={onLocaleChanged}
            />
          ) : (
            <div className="settings-content-inner">
              <h2>{i18n.t('developer.title')}</h2>
              <DeveloperSettingsPanel
                authState={authState}
                i18n={i18n}
                onApplied={onDeveloperSettingsChanged}
              />
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

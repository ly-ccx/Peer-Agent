import { useState } from 'react';
import type { I18nRuntime, LocaleCode } from '@zeus-atlas/i18n';
import { useAppearance } from '../../../appearance/AppearanceProvider';
import { clientApi } from '../../../clientApi';

export function GeneralSettingsSection({
  i18n,
  onLocaleChanged,
}: {
  readonly i18n: I18nRuntime;
  readonly onLocaleChanged?: () => Promise<void> | void;
}) {
  const { settings, setMode } = useAppearance();
  const [configStatus, setConfigStatus] = useState<string | null>(null);

  const switchLocale = async (locale: LocaleCode) => {
    if (locale === i18n.locale) return;
    await clientApi.setLocale(locale);
    onLocaleChanged?.();
  };

  const handleExport = async () => {
    try {
      const result = await clientApi.exportConfig();
      setConfigStatus(
        result.canceled
          ? i18n.t('settings.config.canceled')
          : i18n.t('settings.config.exported', { count: result.exported.length, dir: result.targetDir ?? '' }),
      );
    } catch {
      setConfigStatus(i18n.t('settings.config.failed'));
    }
  };

  const handleImport = async () => {
    try {
      const result = await clientApi.importConfig();
      setConfigStatus(
        result.canceled
          ? i18n.t('settings.config.canceled')
          : i18n.t('settings.config.imported', { count: result.imported.length }),
      );
    } catch {
      setConfigStatus(i18n.t('settings.config.failed'));
    }
  };

  return (
    <div className="settings-content-inner">
      <h2>{i18n.t('settings.general')}</h2>

      <div className="settings-group">
        <h3>{i18n.t('appearance.mode')}</h3>
        <p>{i18n.t('settings.appearance.description')}</p>
        <div className="settings-segmented" role="group" aria-label={i18n.t('appearance.mode')}>
          {(['light', 'dark', 'system'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              className={settings.mode === mode ? 'active' : ''}
              onClick={() => setMode(mode)}
            >
              {i18n.t(`appearance.mode.${mode}`)}
            </button>
          ))}
        </div>
      </div>

      <div className="settings-group">
        <h3>{i18n.t('appearance.language')}</h3>
        <p>{i18n.t('settings.language.description')}</p>
        <div className="settings-segmented two-col" role="group" aria-label={i18n.t('appearance.language')}>
          <button
            type="button"
            className={i18n.locale === 'zh-CN' ? 'active' : ''}
            onClick={() => void switchLocale('zh-CN')}
          >
            中文
          </button>
          <button
            type="button"
            className={i18n.locale === 'en-US' ? 'active' : ''}
            onClick={() => void switchLocale('en-US')}
          >
            English
          </button>
        </div>
      </div>

      <div className="settings-group">
        <h3>{i18n.t('settings.config')}</h3>
        <p>{i18n.t('settings.config.description')}</p>
        <div className="settings-segmented two-col" role="group" aria-label={i18n.t('settings.config')}>
          <button type="button" onClick={() => void handleExport()}>
            {i18n.t('settings.config.export')}
          </button>
          <button type="button" onClick={() => void handleImport()}>
            {i18n.t('settings.config.import')}
          </button>
        </div>
        {configStatus ? <p className="settings-config-status">{configStatus}</p> : null}
      </div>
    </div>
  );
}

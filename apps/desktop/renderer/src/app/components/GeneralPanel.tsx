import type { I18nRuntime } from '@peer-agent/i18n';
import type { LocaleCode } from '@peer-agent/protocol';
import { useMemo, useState } from 'react';
import { clientApi } from '../../clientApi';
import { Dropdown } from './Dropdown';

const LOCALE_LABELS: Record<LocaleCode, string> = {
  'zh-CN': '简体中文',
  'en-US': 'English',
};

export interface GeneralPanelProps {
  readonly availableLocales: readonly LocaleCode[];
  readonly i18n: I18nRuntime;
  readonly onLocaleChanged: () => Promise<void> | void;
}

export function GeneralPanel({ availableLocales, i18n, onLocaleChanged }: GeneralPanelProps) {
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const localeOptions = useMemo(() => {
    const locales = availableLocales.length > 0 ? availableLocales : ([i18n.locale] as readonly LocaleCode[]);
    return locales.map((locale) => ({ value: locale, label: LOCALE_LABELS[locale] ?? locale }));
  }, [availableLocales, i18n.locale]);

  async function handleLocaleChange(nextLocale: LocaleCode) {
    if (nextLocale === i18n.locale || isSaving) return;

    setIsSaving(true);
    setError(null);
    try {
      await clientApi.setLocale(nextLocale);
      await onLocaleChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update language.');
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="general-panel">
      <section className="llm-instructions-card general-card">
        <div className="general-setting-row">
          <div className="general-setting-copy">
            <h3>{i18n.t('appearance.language')}</h3>
            <p>{i18n.t('settings.language.description')}</p>
          </div>
          <div className="general-language-select">
            <Dropdown
              value={i18n.locale}
              options={localeOptions}
              disabled={isSaving}
              ariaLabel={i18n.t('appearance.language')}
              onChange={(value) => void handleLocaleChange(value as LocaleCode)}
            />
          </div>
        </div>
        {error ? <p className="general-setting-error">{error}</p> : null}
      </section>
    </div>
  );
}

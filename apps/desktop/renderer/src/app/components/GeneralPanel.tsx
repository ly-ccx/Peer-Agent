import type { I18nRuntime } from '@peer-agent/i18n';
import type { LocaleCode } from '@peer-agent/protocol';
import { useMemo, useState } from 'react';
import { clientApi } from '../../clientApi';
import { Dropdown } from './Dropdown';

const LOCALE_LABELS: Record<LocaleCode, string> = {
  'zh-CN': '简体中文',
  'en-US': 'English',
};

// 回复语言可选项：code 用于产出指令，label 为自展示名称（用各自语言书写，便于识别）。
// 'follow' 表示跟随界面语言（写回 settings 时折算为当前界面 locale）。
const REPLY_LANGUAGE_CHOICES: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'auto', label: '' },
  { value: 'follow', label: '' },
  { value: 'zh-CN', label: '简体中文' },
  { value: 'zh-TW', label: '繁體中文' },
  { value: 'en-US', label: 'English' },
  { value: 'ja-JP', label: '日本語' },
  { value: 'ko-KR', label: '한국어' },
  { value: 'fr-FR', label: 'Français' },
  { value: 'de-DE', label: 'Deutsch' },
  { value: 'es-ES', label: 'Español' },
  { value: 'ru-RU', label: 'Русский' },
];

function readReplyLanguage(settings: Record<string, unknown> | null | undefined): string {
  const value = settings?.replyLanguage;
  return typeof value === 'string' && value.trim() ? value.trim() : 'auto';
}

export interface GeneralPanelProps {
  readonly availableLocales: readonly LocaleCode[];
  readonly i18n: I18nRuntime;
  readonly onLocaleChanged: () => Promise<void> | void;
  readonly onReplyLanguageChanged?: (replyLanguage: string) => void;
}

export function GeneralPanel({ availableLocales, i18n, onLocaleChanged, onReplyLanguageChanged }: GeneralPanelProps) {
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [replyLanguage, setReplyLanguage] = useState(() => readReplyLanguage(clientApi.initialSettings));

  const localeOptions = useMemo(() => {
    const locales = availableLocales.length > 0 ? availableLocales : ([i18n.locale] as readonly LocaleCode[]);
    return locales.map((locale) => ({ value: locale, label: LOCALE_LABELS[locale] ?? locale }));
  }, [availableLocales, i18n.locale]);

  const replyLanguageOptions = useMemo(
    () =>
      REPLY_LANGUAGE_CHOICES.map((choice) => {
        if (choice.value === 'auto') {
          return { value: choice.value, label: i18n.t('settings.replyLanguage.auto') };
        }
        if (choice.value === 'follow') {
          return { value: choice.value, label: i18n.t('settings.replyLanguage.followInterface') };
        }
        return choice;
      }),
    [i18n],
  );

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

  async function handleReplyLanguageChange(nextValue: string) {
    if (nextValue === replyLanguage || isSaving) return;

    // 'follow' 持久化为当前界面 locale，使指令具体、稳定，不随界面再切换而漂移。
    const persisted = nextValue === 'follow' ? i18n.locale : nextValue;
    const previous = replyLanguage;
    setReplyLanguage(nextValue);
    setIsSaving(true);
    setError(null);
    try {
      await clientApi.updateSettings({ replyLanguage: persisted });
      onReplyLanguageChanged?.(persisted);
    } catch (err) {
      setReplyLanguage(previous);
      setError(err instanceof Error ? err.message : 'Failed to update reply language.');
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
        <div className="general-setting-row">
          <div className="general-setting-copy">
            <h3>{i18n.t('settings.replyLanguage')}</h3>
            <p>{i18n.t('settings.replyLanguage.description')}</p>
          </div>
          <div className="general-language-select">
            <Dropdown
              value={replyLanguage}
              options={replyLanguageOptions}
              disabled={isSaving}
              ariaLabel={i18n.t('settings.replyLanguage')}
              onChange={(value) => void handleReplyLanguageChange(value)}
            />
          </div>
        </div>
        {error ? <p className="general-setting-error">{error}</p> : null}
      </section>
    </div>
  );
}

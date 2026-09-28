import type { I18nRuntime } from '@peer-agent/i18n';
import type { LocaleCode } from '@peer-agent/protocol';
import { useEffect, useMemo, useState } from 'react';
import { clientApi } from '../../clientApi';
import { projectAgentShellOf, publishProjectAgentShell, type ProjectAgentShell } from '../../project-agent/onboarding/botShell';
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

const BOT_LEVELS = ['quiet', 'low', 'standard', 'high'] as const;

function readBots(settings: Record<string, unknown> | null | undefined) {
  const agent = settings?.projectAgent;
  const source = agent && typeof agent === 'object' ? agent as Record<string, unknown> : {};
  const hours = source.quietHours && typeof source.quietHours === 'object'
    ? source.quietHours as Record<string, unknown>
    : {};
  const proactivity = BOT_LEVELS.includes(source.proactivity as typeof BOT_LEVELS[number])
    ? source.proactivity as typeof BOT_LEVELS[number]
    : 'standard';
  return {
    proactivity,
    quietEnabled: hours.enabled === true,
    quietStart: typeof hours.start === 'string' && hours.start ? hours.start : '22:00',
    quietEnd: typeof hours.end === 'string' && hours.end ? hours.end : '08:00',
    digestTime: typeof source.digestTime === 'string' && source.digestTime ? source.digestTime : '09:00',
  };
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
  const initialBots = readBots(clientApi.initialSettings);
  const [proactivity, setProactivity] = useState(initialBots.proactivity);
  const [quietEnabled, setQuietEnabled] = useState(initialBots.quietEnabled);
  const [quietStart, setQuietStart] = useState(initialBots.quietStart);
  const [quietEnd, setQuietEnd] = useState(initialBots.quietEnd);
  const [digestTime, setDigestTime] = useState(initialBots.digestTime);
  const [shell, setShell] = useState<ProjectAgentShell>(() => projectAgentShellOf(clientApi.initialSettings));

  useEffect(() => {
    let cancelled = false;
    void clientApi.getSettings().then((settings) => {
      if (!cancelled) setShell(projectAgentShellOf(settings));
    }).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

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

  async function handleShellChange(next: ProjectAgentShell) {
    if (next === shell || isSaving) return;
    const previous = shell;
    setShell(next);
    setIsSaving(true);
    setError(null);
    try {
      await clientApi.updateSettings({ projectAgent: { shell: next } });
      publishProjectAgentShell(next);
    } catch (err) {
      setShell(previous);
      setError(err instanceof Error ? err.message : 'Failed to update interface.');
    } finally {
      setIsSaving(false);
    }
  }

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

  async function saveBots(next: {
    proactivity?: typeof proactivity;
    quietEnabled?: boolean;
    quietStart?: string;
    quietEnd?: string;
    digestTime?: string;
  }) {
    const previous = { proactivity, quietEnabled, quietStart, quietEnd, digestTime };
    const merged = { ...previous, ...next };
    setProactivity(merged.proactivity);
    setQuietEnabled(merged.quietEnabled);
    setQuietStart(merged.quietStart);
    setQuietEnd(merged.quietEnd);
    setDigestTime(merged.digestTime);
    setIsSaving(true);
    setError(null);
    try {
      await clientApi.updateSettings({
        projectAgent: {
          proactivity: merged.proactivity,
          quietHours: {
            enabled: merged.quietEnabled,
            start: merged.quietStart,
            end: merged.quietEnd,
          },
          digestTime: merged.digestTime,
        },
      });
    } catch (err) {
      setProactivity(previous.proactivity);
      setQuietEnabled(previous.quietEnabled);
      setQuietStart(previous.quietStart);
      setQuietEnd(previous.quietEnd);
      setDigestTime(previous.digestTime);
      setError(err instanceof Error ? err.message : 'Failed to update bot settings.');
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
            <h3>{i18n.t('settings.shell.title')}</h3>
            <p>{i18n.t('settings.shell.description')}</p>
          </div>
          <div className="general-language-select">
            <Dropdown
              value={shell}
              options={[
                { value: 'bots', label: i18n.t('settings.shell.bots') },
                { value: 'classic', label: i18n.t('settings.shell.classic') },
              ]}
              disabled={isSaving}
              ariaLabel={i18n.t('settings.shell.title')}
              onChange={(value) => void handleShellChange(value === 'classic' ? 'classic' : 'bots')}
            />
          </div>
        </div>
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
      <section className="llm-instructions-card general-card">
        <div className="general-setting-row">
          <div className="general-setting-copy">
            <h3>{i18n.t('settings.bots.title')}</h3>
            <p>{i18n.t('settings.bots.proactivity')}</p>
          </div>
          <div className="general-language-select">
            <Dropdown
              value={proactivity}
              options={BOT_LEVELS.map((level) => ({
                value: level,
                label: i18n.t(`settings.bots.proactivity.${level}`),
              }))}
              disabled={isSaving}
              ariaLabel={i18n.t('settings.bots.proactivity')}
              onChange={(value) => { void saveBots({ proactivity: value as typeof proactivity }); }}
            />
          </div>
        </div>
        <div className="general-setting-row">
          <div className="general-setting-copy">
            <h3>{i18n.t('settings.bots.quietHours')}</h3>
            <p>{i18n.t('settings.bots.quietHours.description')}</p>
          </div>
          <label className="general-bots-hours">
            <input
              type="checkbox"
              checked={quietEnabled}
              disabled={isSaving}
              onChange={(event) => { void saveBots({ quietEnabled: event.target.checked }); }}
            />
            <input
              type="time"
              value={quietStart}
              disabled={isSaving}
              aria-label={i18n.t('settings.bots.quietHours')}
              onChange={(event) => { void saveBots({ quietStart: event.target.value }); }}
            />
            <input
              type="time"
              value={quietEnd}
              disabled={isSaving}
              aria-label={i18n.t('settings.bots.quietHours')}
              onChange={(event) => { void saveBots({ quietEnd: event.target.value }); }}
            />
          </label>
        </div>
        <div className="general-setting-row">
          <div className="general-setting-copy">
            <h3>{i18n.t('settings.bots.digestTime')}</h3>
            <p>{i18n.t('settings.bots.digestTime.description')}</p>
          </div>
          <input
            type="time"
            value={digestTime}
            disabled={isSaving}
            aria-label={i18n.t('settings.bots.digestTime')}
            onChange={(event) => { void saveBots({ digestTime: event.target.value }); }}
          />
        </div>
      </section>
    </div>
  );
}

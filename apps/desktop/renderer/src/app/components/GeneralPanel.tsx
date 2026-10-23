import { useEditableResource } from '../../ui/forms/useEditableResource';
import { useSettingsAction } from '../../ui/forms/useSettingsAction';
import { FormFeedback } from '../../ui/forms/FormFeedback';
import { useUnsavedChanges } from '../../ui/forms/UnsavedChanges';
import type { I18nRuntime } from '@peer-agent/i18n';
import type { LocaleCode } from '@peer-agent/protocol';
import { useMemo } from 'react';
import { clientApi } from '../../clientApi';
import { projectAgentShellOf, publishProjectAgentShell, type ProjectAgentShell } from '../../project-agent/onboarding/botShell';
import { Switch } from '../../ui/boolean-controls/Switch';
import { SettingsGroup } from '../../ui/settings/SettingsGroup';
import { BotTimeField } from './BotTimeField';
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

function readGeneral(settings: Record<string, unknown> | null | undefined) {
  return { ...readBots(settings), shell: projectAgentShellOf(settings), replyLanguage: readReplyLanguage(settings) };
}

export interface GeneralPanelProps {
  readonly availableLocales: readonly LocaleCode[];
  readonly i18n: I18nRuntime;
  readonly onLocaleChanged: () => Promise<void> | void;
  readonly onReplyLanguageChanged?: (replyLanguage: string) => void;
}

export function GeneralPanel({ availableLocales, i18n, onLocaleChanged, onReplyLanguageChanged }: GeneralPanelProps) {
  const localeAction = useSettingsAction();
  const form = useEditableResource('settings.general', readGeneral(clientApi.initialSettings), {
    read: async () => readGeneral(await clientApi.getSettings()),
    write: async (draft, saved) => {
      const projectAgent: Record<string, unknown> = {};
      if (draft.shell !== saved.shell) projectAgent.shell = draft.shell;
      if (draft.proactivity !== saved.proactivity) projectAgent.proactivity = draft.proactivity;
      if (draft.quietEnabled !== saved.quietEnabled || draft.quietStart !== saved.quietStart || draft.quietEnd !== saved.quietEnd) projectAgent.quietHours = { enabled: draft.quietEnabled, start: draft.quietStart, end: draft.quietEnd };
      if (draft.digestTime !== saved.digestTime) projectAgent.digestTime = draft.digestTime;
      const patch = { ...(Object.keys(projectAgent).length ? { projectAgent } : {}), ...(draft.replyLanguage !== saved.replyLanguage ? { replyLanguage: draft.replyLanguage === 'follow' ? i18n.locale : draft.replyLanguage } : {}) };
      const receipt = readGeneral(await clientApi.updateSettings(patch));
      if (receipt.replyLanguage !== saved.replyLanguage) onReplyLanguageChanged?.(receipt.replyLanguage);
      if (receipt.shell !== saved.shell) publishProjectAgentShell(receipt.shell);
      return receipt;
    },
  });
  useUnsavedChanges({ dirty: form.dirty, busy: form.saving || localeAction.busy, save: form.save, discard: form.reset });
  const { replyLanguage, proactivity, quietEnabled, quietStart, quietEnd, digestTime, shell } = form.draft;
  const controlsDisabled = !form.loaded || form.saving || localeAction.busy;
  async function change(next: Partial<ReturnType<typeof readGeneral>>) {
    if (controlsDisabled) return;
    form.edit({ ...form.draft, ...next }); await form.save();
  }
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

  const handleShellChange = (shell: ProjectAgentShell) => change({ shell });
  async function handleLocaleChange(next: LocaleCode) {
    if (next === i18n.locale || controlsDisabled) return;
    await localeAction.run(async () => { await clientApi.setLocale(next); await onLocaleChanged(); });
  }
  const saveBots = (next: Partial<ReturnType<typeof readBots>>) => change(next);
  const handleReplyLanguageChange = (replyLanguage: string) => change({ replyLanguage });

  return (
    <div className="general-panel">
      <header className="general-panel-header">
        <h1>{i18n.t('settings.general')}</h1>
        <p>{i18n.t('settings.general.description')}</p>
      </header>
      <SettingsGroup title={i18n.t('settings.general.interfaceAndLanguage')} description={i18n.t('settings.general.interfaceAndLanguage.description')} className="general-section">
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
                disabled={controlsDisabled}
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
                disabled={controlsDisabled}
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
                triggerLabel={replyLanguage === 'auto' ? i18n.t('settings.replyLanguage.autoShort') : undefined}
                title={replyLanguageOptions.find(option => option.value === replyLanguage)?.label}
                disabled={controlsDisabled}
                ariaLabel={i18n.t('settings.replyLanguage')}
                onChange={(value) => void handleReplyLanguageChange(value)}
              />
            </div>
          </div>
      </SettingsGroup>
      <SettingsGroup title={i18n.t('settings.bots.title')} description={i18n.t('settings.bots.description')} className="general-section">
          <div className="general-setting-row">
            <div className="general-setting-copy">
              <h3>{i18n.t('settings.bots.proactivity')}</h3>
              <p>{i18n.t('settings.bots.proactivity.description')}</p>
            </div>
            <div className="general-language-select">
              <Dropdown
                value={proactivity}
                options={BOT_LEVELS.map((level) => ({
                  value: level,
                  label: i18n.t(`settings.bots.proactivity.${level}`),
                }))}
                disabled={controlsDisabled}
                ariaLabel={i18n.t('settings.bots.proactivity')}
                onChange={(value) => { void saveBots({ proactivity: value as typeof proactivity }); }}
              />
            </div>
          </div>
          <div className="general-setting-row general-quiet-setting">
            <div className="general-setting-copy">
              <h3>{i18n.t('settings.bots.quietHours')}</h3>
              <p>{i18n.t('settings.bots.quietHours.description')}</p>
            </div>
            <div className="general-quiet-controls">
              <Switch checked={quietEnabled} disabled={controlsDisabled} aria-label={i18n.t('settings.bots.quietHours')}
                onCheckedChange={value => { void saveBots({ quietEnabled: value }); }} />
              <div className="general-bots-hours">
                <BotTimeField value={quietStart} disabled={controlsDisabled || !quietEnabled} i18n={i18n} label={i18n.t('projectAgent.settings.quietStart')}
                  onChange={value => { void saveBots({ quietStart: value }); }} />
                <span aria-hidden="true">–</span>
                <BotTimeField value={quietEnd} disabled={controlsDisabled || !quietEnabled} i18n={i18n} label={i18n.t('projectAgent.settings.quietEnd')}
                  onChange={value => { void saveBots({ quietEnd: value }); }} />
              </div>
            </div>
          </div>
          <div className="general-setting-row">
            <div className="general-setting-copy">
              <h3>{i18n.t('settings.bots.digestTime')}</h3>
              <p>{i18n.t('settings.bots.digestTime.description')}</p>
            </div>
            <BotTimeField value={digestTime} disabled={controlsDisabled} i18n={i18n} label={i18n.t('settings.bots.digestTime')}
              onChange={value => { void saveBots({ digestTime: value }); }} />
          </div>
      </SettingsGroup>
      <FormFeedback i18n={i18n} {...form} onReload={form.reload} onRetry={form.save} />
      <FormFeedback i18n={i18n} saving={localeAction.busy} saveError={localeAction.error} onRetry={localeAction.retry} />
    </div>
  );
}

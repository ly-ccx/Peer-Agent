import type { I18nRuntime } from '@peer-agent/i18n';
import type { LocaleCode } from '@peer-agent/protocol';
import { useState } from 'react';
import { AppearancePanel } from '../../appearance/AppearancePanel';
import { GeneralPanel } from './GeneralPanel';
import { LlmSettingsPanel } from './LlmSettingsPanel';
import { SystemInstructionsPanel } from './SystemInstructionsPanel';

type SettingsSection = 'general' | 'model' | 'instructions' | 'appearance';

/**
 * SettingsPage 是设置入口的单一表达层:
 *   - 左侧:设置分区列表(通用 / 模型配置 / 系统指令 / 外观)
 *   - 右侧:当前选中分区的具体配置内容
 *
 * 它本身不承载任何能力执行,只负责在已有的配置面板
 * (GeneralPanel / LlmSettingsPanel / SystemInstructionsPanel / AppearancePanel)之间
 * 做分区切换与布局。各面板的数据读写仍走各自既有的 clientApi 契约。
 *
 * 系统指令属于 System Context 输入,与模型 Provider 连接配置职责不同,
 * 因此独立成分区,不再内嵌于模型配置面板。
 */
export function SettingsPage({
  availableLocales,
  i18n,
  onBack,
  onLocaleChanged,
  onSystemInstructionsChanged,
}: {
  readonly availableLocales: readonly LocaleCode[];
  readonly i18n: I18nRuntime;
  readonly onBack: () => void;
  readonly onLocaleChanged: () => Promise<void> | void;
  readonly onSystemInstructionsChanged?: (value: string) => void;
}) {
  const [section, setSection] = useState<SettingsSection>('general');
  const localizedSettingsLabels =
    i18n.locale === 'en-US'
      ? { model: 'Model configuration', instructions: 'System instructions' }
      : { model: '模型配置', instructions: '系统指令' };
  const items: ReadonlyArray<{ key: SettingsSection; label: string }> = [
    { key: 'general', label: i18n.t('settings.general') },
    { key: 'model', label: localizedSettingsLabels.model },
    { key: 'instructions', label: localizedSettingsLabels.instructions },
    { key: 'appearance', label: i18n.t('appearance.title') },
  ];

  return (
    <div className="settings-page">
      <aside className="settings-nav" aria-label={i18n.t('app.settings')}>
        <header className="settings-nav-header">
          <button type="button" onClick={onBack} aria-label="Back">
            ←
          </button>
          <strong>{i18n.t('app.settings')}</strong>
        </header>
        <nav className="settings-nav-list">
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              className={`settings-nav-item ${section === item.key ? 'active' : ''}`}
              aria-current={section === item.key}
              onClick={() => setSection(item.key)}
            >
              {item.label}
            </button>
          ))}
        </nav>
      </aside>

      {/* key={section} 让每次切换分区时内容重新挂载,触发 .settings-content > *
          的 za-content-reveal 入场动画(动效约定见 settings-page.css)。 */}
      <section className="settings-content" aria-live="polite" key={section}>
        {section === 'general' ? (
          <GeneralPanel
            availableLocales={availableLocales}
            i18n={i18n}
            onLocaleChanged={onLocaleChanged}
          />
        ) : section === 'model' ? (
          <LlmSettingsPanel i18n={i18n} />
        ) : section === 'instructions' ? (
          <SystemInstructionsPanel
            i18n={i18n}
            onSystemInstructionsChanged={onSystemInstructionsChanged}
          />
        ) : (
          <AppearancePanel i18n={i18n} />
        )}
      </section>
    </div>
  );
}

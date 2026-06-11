import type { I18nRuntime } from '@peer-agent/i18n';
import { useState } from 'react';
import { AppearancePanel } from '../../appearance/AppearancePanel';
import { LlmSettingsPanel } from './LlmSettingsPanel';
import { SystemInstructionsPanel } from './SystemInstructionsPanel';

type SettingsSection = 'model' | 'instructions' | 'appearance';

/**
 * SettingsPage 是设置入口的单一表达层:
 *   - 左侧:设置分区列表(模型配置 / 系统指令 / 外观)
 *   - 右侧:当前选中分区的具体配置内容
 *
 * 它本身不承载任何能力执行,只负责在已有的配置面板
 * (LlmSettingsPanel / SystemInstructionsPanel / AppearancePanel)之间
 * 做分区切换与布局。各面板的数据读写仍走各自既有的 clientApi 契约。
 *
 * 系统指令属于 System Context 输入,与模型 Provider 连接配置职责不同,
 * 因此独立成分区,不再内嵌于模型配置面板。
 */
export function SettingsPage({
  i18n,
  onBack,
  onSystemInstructionsChanged,
}: {
  readonly i18n: I18nRuntime;
  readonly onBack: () => void;
  readonly onSystemInstructionsChanged?: (value: string) => void;
}) {
  const [section, setSection] = useState<SettingsSection>('instructions');
  const isZh = i18n.locale === 'zh-CN';

  const items: ReadonlyArray<{ key: SettingsSection; label: string }> = [
    { key: 'instructions', label: isZh ? '系统指令' : 'System Instructions' },
    { key: 'model', label: isZh ? '模型配置' : 'Model Settings' },
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

      <section className="settings-content" aria-live="polite">
        {section === 'model' ? (
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

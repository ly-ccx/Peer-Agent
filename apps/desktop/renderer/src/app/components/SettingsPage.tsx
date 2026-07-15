import type { I18nRuntime } from '@peer-agent/i18n';
import type { LocaleCode } from '@peer-agent/protocol';
import { useState } from 'react';
import { AppearancePanel } from '../../appearance/AppearancePanel';
import { ArchivedConversationsPanel } from './ArchivedConversationsPanel';
import { CapabilitiesPanel } from './CapabilitiesPanel';
import { GeneralPanel } from './GeneralPanel';
import { GitPanel } from './GitPanel';
import { LlmSettingsPanel } from './LlmSettingsPanel';
import { SystemInstructionsPanel } from './SystemInstructionsPanel';
import { ShortcutsPanel } from './ShortcutsPanel';
import { UpdatesPanel } from './UpdatesPanel';

type SettingsSection = 'general' | 'archived' | 'model' | 'skills' | 'instructions' | 'git' | 'shortcuts' | 'appearance' | 'updates';

/**
 * SettingsPage 是设置入口的单一表达层:
 *   - 左侧:设置分区列表(通用 / 模型配置 / 个性化设置 / 外观)
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
  onReplyLanguageChanged,
  onSystemInstructionsChanged,
  onGitBranchPrefixChanged,
  workspacePath,
  onArchivedConversationsChanged,
}: {
  readonly availableLocales: readonly LocaleCode[];
  readonly i18n: I18nRuntime;
  readonly onBack: () => void;
  readonly onLocaleChanged: () => Promise<void> | void;
  readonly onReplyLanguageChanged?: (replyLanguage: string) => void;
  readonly onSystemInstructionsChanged?: (value: string) => void;
  readonly onGitBranchPrefixChanged?: (value: string) => void;
  readonly workspacePath: string | null;
  readonly onArchivedConversationsChanged?: () => Promise<void> | void;
}) {
  const [section, setSection] = useState<SettingsSection>('general');
  const [query, setQuery] = useState('');
  const localizedSettingsLabels =
    i18n.locale === 'en-US'
      ? { model: 'Model configuration', skills: 'Capabilities', instructions: 'Personalization' }
      : { model: '模型配置', skills: '能力', instructions: '个性化设置' };
  const items: ReadonlyArray<{ key: SettingsSection; label: string }> = [
    { key: 'general', label: i18n.t('settings.general') },
    { key: 'archived', label: i18n.t('settings.archived') },
    { key: 'model', label: localizedSettingsLabels.model },
    { key: 'skills', label: localizedSettingsLabels.skills },
    { key: 'instructions', label: localizedSettingsLabels.instructions },
    { key: 'git', label: i18n.t('settings.git') },
    { key: 'shortcuts', label: i18n.locale === 'zh-CN' ? '快捷键' : 'Keyboard shortcuts' },
    { key: 'appearance', label: i18n.t('appearance.title') },
    { key: 'updates', label: i18n.t('updater.settings.title') },
  ];
  // 搜索仅过滤左侧分区导航项（按 label 子串匹配），不做跨面板深搜。
  const normalizedQuery = query.trim().toLowerCase();
  const visibleItems = normalizedQuery
    ? items.filter((item) => item.label.toLowerCase().includes(normalizedQuery))
    : items;

  return (
    <div className="settings-page">
      <aside className="settings-nav" aria-label={i18n.t('app.settings')}>
        <header className="settings-nav-header">
          <button type="button" onClick={onBack} aria-label="Back">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M19 12H5" />
              <path d="m12 19-7-7 7-7" />
            </svg>
          </button>
          <strong>{i18n.t('app.settings')}</strong>
        </header>
        <div className="settings-nav-search">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="m21 21-4.3-4.3" />
          </svg>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={i18n.t('settings.search')}
            aria-label={i18n.t('settings.search')}
          />
        </div>
        <nav className="settings-nav-list">
          {visibleItems.length === 0 ? (
            <p className="settings-nav-empty">{i18n.t('settings.searchEmpty')}</p>
          ) : (
            visibleItems.map((item) => (
              <button
                key={item.key}
                type="button"
                className={`settings-nav-item ${section === item.key ? 'active' : ''}`}
                aria-current={section === item.key}
                onClick={() => setSection(item.key)}
              >
                {item.label}
              </button>
            ))
          )}
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
            onReplyLanguageChanged={onReplyLanguageChanged}
          />
        ) : section === 'archived' ? (
          <ArchivedConversationsPanel
            i18n={i18n}
            workspacePath={workspacePath}
            onConversationsChanged={onArchivedConversationsChanged}
          />
        ) : section === 'model' ? (
          <LlmSettingsPanel i18n={i18n} />
        ) : section === 'skills' ? (
          <CapabilitiesPanel />
        ) : section === 'instructions' ? (
          <SystemInstructionsPanel
            i18n={i18n}
            onSystemInstructionsChanged={onSystemInstructionsChanged}
          />
        ) : section === 'git' ? (
          <GitPanel i18n={i18n} onGitBranchPrefixChanged={onGitBranchPrefixChanged} />
        ) : section === 'shortcuts' ? (
          <ShortcutsPanel />
        ) : section === 'updates' ? (
          <UpdatesPanel i18n={i18n} />
        ) : (
          <AppearancePanel i18n={i18n} />
        )}
      </section>
    </div>
  );
}

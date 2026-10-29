import './settings-controls.css';
import '../../styles/settings-page.css';
import type { I18nRuntime } from '@peer-agent/i18n';
import type { LocaleCode } from '@peer-agent/protocol';
import { useState } from 'react';
import { UnsavedChangesProvider, useGuardedNavigation } from '../../ui/forms/UnsavedChanges';
import { deferPanel } from './deferPanel';
const AppearancePanel = deferPanel(() => import('../../appearance/AppearancePanel').then(module => ({ default: module.AppearancePanel })));
const ArchivedConversationsPanel = deferPanel(() => import('./ArchivedConversationsPanel').then(module => ({ default: module.ArchivedConversationsPanel })));
const GeneralPanel = deferPanel(() => import('./GeneralPanel').then(module => ({ default: module.GeneralPanel })));
const GitPanel = deferPanel(() => import('./GitPanel').then(module => ({ default: module.GitPanel })));
const LlmSettingsPanel = deferPanel(() => import('./LlmSettingsPanel').then(module => ({ default: module.LlmSettingsPanel })));
const SystemInstructionsPanel = deferPanel(() => import('./SystemInstructionsPanel').then(module => ({ default: module.SystemInstructionsPanel })));
const ShortcutsPanel = deferPanel(() => import('./ShortcutsPanel').then(module => ({ default: module.ShortcutsPanel })));
const UpdatesPanel = deferPanel(() => import('./UpdatesPanel').then(module => ({ default: module.UpdatesPanel })));
const RemoteAccessPanel = deferPanel(() => import('./RemoteAccessPanel').then(module => ({ default: module.RemoteAccessPanel })));
const UsageStatsPanel = deferPanel(() => import('../../settings/UsageStatsPanel').then(module => ({ default: module.UsageStatsPanel })));
const ModelRoutingPanel = deferPanel(() => import('./settings/ModelRoutingPanel').then(module => ({ default: module.ModelRoutingPanel })));
const DeveloperPanel = deferPanel(() => import('./settings/DeveloperPanel').then(module => ({ default: module.DeveloperPanel })));

export type SettingsSection = 'general' | 'providers' | 'routing' | 'model' | 'instructions' | 'git' | 'developer' | 'shortcuts' | 'appearance' | 'updates' | 'archived' | 'usage' | 'remote';
// 注：model 仅为 deep-link 兼容别名，导航只展示「服务商」。
// 注：skills/插件已提升为主侧栏一级页面，不再作为设置分区。
type SettingsGroup = { readonly label: string; readonly items: ReadonlyArray<{ key: SettingsSection; label: string }>; readonly lowPriority?: boolean };

// Appshots is intentionally hidden from Settings for now (not part of public beta surface).
const SETTINGS_SECTIONS: ReadonlySet<SettingsSection> = new Set([
  'general',
  'providers',
  'routing',
  'model', // legacy alias → providers
  'instructions',
  'git',
  'developer',
  'shortcuts',
  'appearance',
  'updates',
  'archived',
  'usage',
  'remote',
]);

function resolveSettingsSection(value: string | null | undefined): SettingsSection {
  // Legacy deep-links like ?section=appshots fall back to general.
  // 旧 model 分区统一映射到服务商（以服务商为聚合源头，不设独立模型页）。
  // 旧 skills 分区已外置为一级页，deep-link 回落到 general。
  if (value === 'model' || value === 'models') return 'providers';
  if (value === 'skills') return 'general';
  if (value && SETTINGS_SECTIONS.has(value as SettingsSection)) {
    return value as SettingsSection;
  }
  return 'general';
}

/**
 * SettingsPage 是设置入口的单一表达层:
 *   - 左侧:设置分区列表(通用 / 服务商 / 个性化设置 / 外观)
 *   - 右侧:当前选中分区的具体配置内容
 *
 * 它本身不承载任何能力执行,只负责在已有的配置面板
 * (GeneralPanel / LlmSettingsPanel / SystemInstructionsPanel / AppearancePanel)之间
 * 做分区切换与布局。各面板的数据读写仍走各自既有的 clientApi 契约。
 *
 * 系统指令属于 System Context 输入,与模型 Provider 连接配置职责不同,
 * 因此独立成分区,不再内嵌于服务商面板。
 */
function SettingsPageContent({
  availableLocales,
  i18n,
  initialSection = 'general',
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
  /** 打开设置页时落到的分区；首启连接服务应传 `providers`。 */
  readonly initialSection?: SettingsSection | null;
  readonly onBack: () => void;
  readonly onLocaleChanged: () => Promise<void> | void;
  readonly onReplyLanguageChanged?: (replyLanguage: string) => void;
  readonly onSystemInstructionsChanged?: (value: string) => void;
  readonly onGitBranchPrefixChanged?: (value: string) => void;
  readonly workspacePath: string | null;
  readonly onArchivedConversationsChanged?: () => Promise<void> | void;
}) {
  const navigate = useGuardedNavigation();
  const [section, setSection] = useState<SettingsSection>(() => resolveSettingsSection(initialSection));
  const [query, setQuery] = useState('');
  const isZh = i18n.locale === 'zh-CN';
  const groups: readonly SettingsGroup[] = [
    {
      label: isZh ? '个人' : 'Personal',
      items: [
        { key: 'general', label: i18n.t('settings.general') },
        { key: 'appearance', label: i18n.t('appearance.title') },
        { key: 'instructions', label: isZh ? '个性化' : 'Personalization' },
        { key: 'shortcuts', label: isZh ? '快捷键' : 'Keyboard shortcuts' },
      ],
    },
    {
      label: 'AI',
      items: [
        { key: 'providers', label: isZh ? '服务商' : 'Providers' },
        { key: 'routing', label: i18n.t('modelRouting.nav') },
        { key: 'usage', label: i18n.t('settings.usage') },
      ],
    },
    { label: isZh ? '开发' : 'Development', items: [
      { key: 'git', label: i18n.t('settings.git') },
      { key: 'developer', label: i18n.t('developer.projectAgent.nav') },
    ] },
    {
      label: isZh ? '连接' : 'Connectivity',
      items: [{ key: 'remote', label: isZh ? '远程访问' : 'Remote access' }],
    },
    { label: isZh ? '应用' : 'Application', items: [{ key: 'updates', label: isZh ? '更新与关于' : 'Updates & about' }] },
    {
      label: isZh ? '归档' : 'Archived',
      items: [{ key: 'archived', label: isZh ? '已归档会话' : 'Archived chats' }],
      lowPriority: true,
    },
  ];
  // 搜索仅过滤左侧分区导航项（按 label 子串匹配），不做跨面板深搜。
  const normalizedQuery = query.trim().toLowerCase();
  const visibleGroups = groups
    .map((group) => ({ ...group, items: group.items.filter((item) => !normalizedQuery || item.label.toLowerCase().includes(normalizedQuery)) }))
    .filter((group) => group.items.length > 0);

  return (
    <div className="settings-page">
      <aside className="settings-nav" aria-label={i18n.t('app.settings')}>
        <header className="settings-nav-header">
          <button type="button" onClick={() => navigate(onBack)} aria-label={i18n.t('app.settings')}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M19 12H5" />
              <path d="m12 19-7-7 7-7" />
            </svg>
            <strong>{i18n.t('app.settings')}</strong>
          </button>
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
          {visibleGroups.length === 0 ? (
            <p className="settings-nav-empty">{i18n.t('settings.searchEmpty')}</p>
          ) : (
            visibleGroups.map((group) => (
              <section className={`settings-nav-group ${group.lowPriority ? 'settings-nav-group-low-priority' : ''}`} key={group.label} aria-label={group.label}>
                <h2>{group.label}</h2>
                {group.items.map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    className={`settings-nav-item ${section === item.key ? 'active' : ''}`}
                    aria-current={section === item.key ? 'page' : undefined}
                    onClick={() => { if (section !== item.key) navigate(() => setSection(item.key)); }}
                  >
                    {item.label}
                  </button>
                ))}
              </section>
            ))
          )}
        </nav>
      </aside>

      {/* Draft ownership is explicit; remounting a section is not a save or discard. */}
      <section className="settings-content" aria-live="polite" key={section}>
        {section === 'general' ? (
          <GeneralPanel
            availableLocales={availableLocales}
            i18n={i18n}
            onLocaleChanged={onLocaleChanged}
            onReplyLanguageChanged={onReplyLanguageChanged}
          />
        ) : section === 'providers' || section === 'model' ? (
          <div className="settings-provider-page">
            <LlmSettingsPanel i18n={i18n} />
          </div>
        ) : section === 'instructions' ? (
          <SystemInstructionsPanel
            i18n={i18n}
            onSystemInstructionsChanged={onSystemInstructionsChanged}
          />
        ) : section === 'developer' ? (
          <DeveloperPanel i18n={i18n} />
        ) : section === 'git' ? (
          <GitPanel
            i18n={i18n}
            workspacePath={workspacePath}
            onGitBranchPrefixChanged={onGitBranchPrefixChanged}
          />
        ) : section === 'shortcuts' ? (
          <ShortcutsPanel />
        ) : section === 'updates' ? (
          <UpdatesPanel i18n={i18n} />
        ) : section === 'archived' ? (
          <ArchivedConversationsPanel
            i18n={i18n}
            workspacePath={workspacePath}
            onConversationsChanged={onArchivedConversationsChanged}
          />
        ) : section === 'routing' ? (
          <ModelRoutingPanel i18n={i18n} />
        ) : section === 'usage' ? (
          <UsageStatsPanel i18n={i18n} />
        ) : section === 'remote' ? (
          <RemoteAccessPanel i18n={i18n} />
        ) : (
          <AppearancePanel i18n={i18n} />
        )}
      </section>
    </div>
  );
}

export function SettingsPage(props: Parameters<typeof SettingsPageContent>[0]) {
  return <UnsavedChangesProvider i18n={props.i18n}><SettingsPageContent {...props} /></UnsavedChangesProvider>;
}

export type SkillSubTab = 'installed' | 'dingtalk' | 'aone';

const TABS: readonly { id: SkillSubTab; label: string }[] = [
  { id: 'installed', label: '已接入' },
  { id: 'aone', label: 'Aone 内网' },
  { id: 'dingtalk', label: '钉钉市场' },
];

export function SkillSubTabs({
  activeTab,
  onChange,
}: {
  readonly activeTab: SkillSubTab;
  readonly onChange: (tab: SkillSubTab) => void;
}) {
  return (
    <div className="skill-sub-tabs" role="tablist" aria-label="Skill 来源">
      {TABS.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={activeTab === tab.id}
          className={activeTab === tab.id ? 'active' : ''}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

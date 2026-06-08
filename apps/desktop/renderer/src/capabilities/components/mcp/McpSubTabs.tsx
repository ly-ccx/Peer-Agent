export type McpSubTab = 'installed' | 'dingtalk' | 'aone';

const TABS: readonly { id: McpSubTab; label: string }[] = [
  { id: 'installed', label: '已接入' },
  { id: 'aone', label: 'Aone 内网' },
  { id: 'dingtalk', label: '钉钉市场' },
];

export function McpSubTabs({
  activeTab,
  onChange,
}: {
  readonly activeTab: McpSubTab;
  readonly onChange: (tab: McpSubTab) => void;
}) {
  return (
    <div className="mcp-sub-tabs" role="tablist" aria-label="MCP 来源">
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

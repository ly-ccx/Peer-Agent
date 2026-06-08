import type { CapabilityWorkbenchCounts, CapabilityWorkbenchTab } from '../types';

const TABS: readonly { id: CapabilityWorkbenchTab; label: string }[] = [
  { id: 'skills', label: 'Skills' },
  { id: 'mcp', label: 'MCP' },
];

export function CapabilityTabs({
  activeTab,
  counts,
  onChange,
}: {
  readonly activeTab: CapabilityWorkbenchTab;
  readonly counts: CapabilityWorkbenchCounts;
  readonly onChange: (tab: CapabilityWorkbenchTab) => void;
}) {
  return (
    <div className="capability-tabs" role="tablist" aria-label="能力类型">
      {TABS.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={activeTab === tab.id}
          className={activeTab === tab.id ? 'active' : ''}
          onClick={() => onChange(tab.id)}
        >
          {tab.label} {counts[tab.id]}
        </button>
      ))}
    </div>
  );
}

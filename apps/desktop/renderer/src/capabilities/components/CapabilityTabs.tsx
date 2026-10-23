import { selectionNavigation } from '../../app/components/selectionNavigation';
import { isImeKey } from '../../chat/state/compositionGuard';
import { useState } from 'react';
import type { CapabilityWorkbenchCounts, CapabilityWorkbenchTab } from '../types';

const TABS: readonly { id: CapabilityWorkbenchTab; label: string }[] = [
  { id: 'skills', label: 'Skills' },
  { id: 'mcp', label: 'MCP' },
];

export function CapabilityTabs({
  activeTab,
  counts,
  onChange,
  idPrefix,
}: {
  readonly idPrefix: string;
  readonly activeTab: CapabilityWorkbenchTab;
  readonly counts: CapabilityWorkbenchCounts;
  readonly onChange: (tab: CapabilityWorkbenchTab) => void;
}) {
  const [focused, setFocused] = useState<string | null>(null);
  return (
    <div className="capability-tabs" role="tablist" aria-label="能力类型" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(null); }}>
      {TABS.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          id={`${idPrefix}-tab-${tab.id}`} aria-controls={`${idPrefix}-panel`}
          tabIndex={(focused ?? activeTab) === tab.id ? 0 : -1}
          onFocus={() => setFocused(tab.id)}
          onKeyDown={event => {
            if (isImeKey(event.nativeEvent)) return;
            const next = selectionNavigation(TABS.map(() => ({})), TABS.findIndex(item => item.id === tab.id), event.key, 'horizontal', getComputedStyle(event.currentTarget).direction === 'rtl');
            if (next === null) return; event.preventDefault();
            document.getElementById(`${idPrefix}-tab-${TABS[next]!.id}`)?.focus({ preventScroll: true });
          }}
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

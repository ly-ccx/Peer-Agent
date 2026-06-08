import type { AutomationStatusFilter } from './cronSession';

const statusTabs: readonly { readonly key: AutomationStatusFilter; readonly label: string }[] = [
  { key: 'running', label: '运行中' },
  { key: 'paused', label: '已暂停' },
  { key: 'ended', label: '已结束' },
  { key: 'all', label: '全部' },
];

export function AutomationStatusTabs({
  active,
  counts,
  onChange,
}: {
  readonly active: AutomationStatusFilter;
  readonly counts: Record<AutomationStatusFilter, number>;
  readonly onChange: (filter: AutomationStatusFilter) => void;
}) {
  return (
    <div className="automation-status-tabs">
      {statusTabs.map((tab) => (
        <button
          key={tab.key}
          type="button"
          className={active === tab.key ? 'active' : ''}
          onClick={() => onChange(tab.key)}
        >
          <span>{tab.label}</span>
          <small>{counts[tab.key]}</small>
        </button>
      ))}
    </div>
  );
}

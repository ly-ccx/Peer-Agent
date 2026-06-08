import type { CapabilityWorkbenchItem } from '../types';

export function CapabilityCard({
  active,
  item,
  onSelect,
}: {
  readonly active: boolean;
  readonly item: CapabilityWorkbenchItem;
  readonly onSelect: (item: CapabilityWorkbenchItem) => void;
}) {
  return (
    <button
      type="button"
      className={`capability-card ${active ? 'active' : ''} ${item.locality === 'local' ? 'local' : ''}`}
      onClick={() => onSelect(item)}
    >
      <span className="capability-card-marker" aria-hidden="true" />
      <span className="capability-card-head">
        <strong>{item.name}</strong>
        <span className={`capability-state ${item.statusTone}`}>
          <i aria-hidden="true" />
          {item.statusLabel}
        </span>
      </span>
      <span className="capability-card-meta">
        <code>[{item.kindLabel} · {item.originLabel}]</code>
        {item.riskLabel ? <em className={item.riskTone}>{item.riskLabel}</em> : null}
      </span>
      <span className="capability-card-subline">{item.meta.join(' · ')}</span>
    </button>
  );
}

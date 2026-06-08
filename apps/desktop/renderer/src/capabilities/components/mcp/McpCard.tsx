export interface McpCardItem {
  readonly id: string | number;
  readonly name: string;
  readonly description?: string;
  readonly sourceLabel: string;
  readonly providerName?: string;
  readonly toolCount?: number;
  readonly status: 'good' | 'warn' | 'danger' | 'none';
  readonly statusLabel?: string;
  readonly actionLabel?: string;
  readonly onAction?: () => void;
}

export function McpCard({
  item,
  active,
  onSelect,
}: {
  readonly item: McpCardItem;
  readonly active?: boolean;
  readonly onSelect?: (item: McpCardItem) => void;
}) {
  const installed = !item.actionLabel;
  return (
    <div
      className={`mcp-card${active ? ' active' : ''}${installed ? ' mcp-card--installed' : ''}`}
      role="button"
      tabIndex={0}
      onClick={() => onSelect?.(item)}
      onKeyDown={(e) => { if (e.key === 'Enter') onSelect?.(item); }}
    >
      <span className="mcp-card-head">
        {item.status !== 'none' && (
          <i className={`mcp-status-dot ${item.status}`} aria-hidden="true" />
        )}
        <strong>{item.name}</strong>
        {item.statusLabel && (
          <span className={`mcp-status-label ${item.status}`}>{item.statusLabel}</span>
        )}
      </span>
      {item.description && (
        <span className="mcp-card-desc">{item.description}</span>
      )}
      <span className="mcp-card-meta">
        {item.sourceLabel}
        {item.providerName ? ` · ${item.providerName}` : ''}
      </span>
      <span className="mcp-card-footer">
        {item.toolCount != null && <span className="mcp-card-tools">tools: {item.toolCount}</span>}
      </span>
      {item.actionLabel && (
        <button
          type="button"
          className="mcp-card-install-btn"
          onClick={(e) => { e.stopPropagation(); item.onAction?.(); }}
        >
          {item.actionLabel}
        </button>
      )}
    </div>
  );
}

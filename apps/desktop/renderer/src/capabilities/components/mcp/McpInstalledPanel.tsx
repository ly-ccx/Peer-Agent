import type { McpLocalRegistryItem } from '../../../preload/contracts/bootstrapPreloadApi';
import { McpCard, type McpCardItem } from './McpCard';

function toCardItem(item: McpLocalRegistryItem): McpCardItem {
  const sourceLabels: Record<string, string> = {
    dingtalk: '钉钉市场',
    aone: 'Aone 内网',
    custom: '自定义',
  };
  return {
    id: item.mcpId,
    name: item.name,
    description: item.description,
    sourceLabel: sourceLabels[item.source] || item.source,
    providerName: item.providerCorpName,
    toolCount: item.tools.length,
    status: 'good',
    statusLabel: undefined,
  };
}

export function McpInstalledPanel({
  items,
  loading,
  selectedMcpId,
  onSelectMcp,
}: {
  readonly items: readonly McpLocalRegistryItem[];
  readonly loading: boolean;
  readonly selectedMcpId: number | null;
  readonly onSelectMcp: (mcpId: number) => void;
}) {
  if (loading) {
    return <div className="mcp-loading">加载中…</div>;
  }

  if (items.length === 0) {
    return (
      <section className="capability-empty-state" aria-label="暂无已接入 MCP">
        <h3>尚未接入任何 MCP 服务</h3>
        <p>前往「钉钉市场」或「Aone 内网」tab 浏览并接入。</p>
      </section>
    );
  }

  return (
    <div className="mcp-grid">
      {items.map((item) => (
        <McpCard
          key={item.mcpId}
          item={toCardItem(item)}
          active={item.mcpId === selectedMcpId}
          onSelect={() => onSelectMcp(item.mcpId)}
        />
      ))}
    </div>
  );
}

import type { McpDingtalkMarketItem } from '../../../preload/contracts/bootstrapPreloadApi';
import { useCallback, useEffect, useRef, useState } from 'react';
import { clientApi } from '../../../clientApi';
import { McpCard, type McpCardItem } from './McpCard';

function toCardItem(item: McpDingtalkMarketItem, onAction?: () => void): McpCardItem {
  return {
    id: item.mcpId,
    name: item.name,
    description: item.description,
    sourceLabel: item.providerCorpName || '钉钉市场',
    status: item.installed ? 'good' : 'none',
    statusLabel: item.installed ? '已接入' : undefined,
    actionLabel: item.installed ? undefined : '接入',
    onAction,
  };
}

const DEBOUNCE_MS = 400;

export function McpDingtalkMarketPanel({
  refreshKey,
  selectedMcpId,
  onSelectMcp,
  onInstallMcp,
}: {
  readonly refreshKey: number;
  readonly selectedMcpId: number | null;
  readonly onSelectMcp: (mcpId: number) => void;
  readonly onInstallMcp: (mcpId: number) => void;
}) {
  const [items, setItems] = useState<readonly McpDingtalkMarketItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seqRef = useRef(0);

  const load = useCallback(async (keyword = '') => {
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    try {
      const list = await clientApi.mcpListDingtalkMarket({ keyword: keyword || undefined });
      if (seq !== seqRef.current) return;
      setItems(list);
    } catch (err: unknown) {
      if (seq === seqRef.current) {
        setError(err instanceof Error ? err.message : '加载失败');
      }
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => { void load(searchQuery.trim()); }, [load, refreshKey]);

  const handleSearch = useCallback((value: string) => {
    setSearchQuery(value);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => { void load(value.trim()); }, DEBOUNCE_MS);
  }, [load]);

  return (
    <>
      <div className="mcp-search-box">
        <span className="mcp-search-icon" aria-hidden="true">⌕</span>
        <input
          type="text"
          className="mcp-search-input"
          placeholder="搜索 MCP 服务..."
          value={searchQuery}
          onChange={(e) => handleSearch(e.target.value)}
        />
      </div>

      {loading ? (
        <div className="mcp-loading">加载中…</div>
      ) : error ? (
        <section className="capability-empty-state" aria-label="加载失败">
          <h3>加载失败</h3>
          <p>{error}</p>
        </section>
      ) : items.length === 0 ? (
        <section className="capability-empty-state" aria-label="无结果">
          <h3>{searchQuery ? '未找到匹配的 MCP 服务' : '钉钉市场暂无数据'}</h3>
          <p>{searchQuery ? '尝试其他关键词' : '请稍后再试。'}</p>
        </section>
      ) : (
        <div className="mcp-grid">
          {items.map((item) => (
            <McpCard
              key={item.mcpId}
              item={toCardItem(item, item.installed ? undefined : () => onInstallMcp(item.mcpId))}
              active={item.mcpId === selectedMcpId}
              onSelect={() => onSelectMcp(item.mcpId)}
            />
          ))}
        </div>
      )}
    </>
  );
}

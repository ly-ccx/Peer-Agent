import type { McpAoneMarketItem } from '../../preload/contracts/bootstrapPreloadApi';
import { useCallback, useEffect, useRef, useState } from 'react';
import { clientApi } from '../../clientApi';

export function PluginsPanel() {
  const [items, setItems] = useState<readonly McpAoneMarketItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seqRef = useRef(0);

  const load = useCallback(async (keyword = '') => {
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    try {
      const result = await clientApi.mcpListAoneMarket({ keyword: keyword || undefined, resourceType: 'plugin' } as any);
      if (seq !== seqRef.current) return;
      setItems(result?.list ?? []);
    } catch (err: unknown) {
      if (seq === seqRef.current) {
        setError(err instanceof Error ? err.message : '加载失败');
      }
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleSearch = useCallback((value: string) => {
    setSearchQuery(value);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => { void load(value.trim()); }, 400);
  }, [load]);

  return (
    <>
      <div className="mcp-search-box">
        <span className="mcp-search-icon" aria-hidden="true">⌕</span>
        <input
          type="text"
          className="mcp-search-input"
          placeholder="搜索 Plugin..."
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
        <section className="capability-empty-state" aria-label="无数据">
          <h3>{searchQuery ? '未找到匹配结果' : '暂无 Plugin'}</h3>
          <p>{searchQuery ? '尝试其他关键词' : '请稍后再试。'}</p>
        </section>
      ) : (
        <div className="mcp-grid">
          {items.map((item) => (
            <div key={item.id} className="mcp-card">
              <span className="mcp-card-head">
                <strong>{item.name}</strong>
              </span>
              {item.description && <span className="mcp-card-desc">{item.description}</span>}
              <span className="mcp-card-meta">
                {item.provider || 'Aone'}
                {item.latestVersion ? ` · v${item.latestVersion}` : ''}
              </span>
              <button type="button" className="mcp-card-install-btn">
                接入
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

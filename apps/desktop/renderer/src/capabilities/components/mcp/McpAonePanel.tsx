import type { McpAoneMcpServerItem } from '../../../preload/contracts/bootstrapPreloadApi';
import { useCallback, useEffect, useRef, useState } from 'react';
import { clientApi } from '../../../clientApi';

const DEBOUNCE_MS = 400;

export function McpAonePanel({
  installedCodes,
  onInstall,
}: {
  readonly installedCodes: ReadonlySet<string>;
  readonly onInstall: (serverName: string) => Promise<void>;
}) {
  const [items, setItems] = useState<readonly McpAoneMcpServerItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [installingCode, setInstallingCode] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seqRef = useRef(0);

  const loadMarket = useCallback(async (keyword = '') => {
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    try {
      const result = await clientApi.mcpListAoneMcpServers({ keyword: keyword || undefined, pageSize: 50 });
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

  useEffect(() => { void loadMarket(); }, [loadMarket]);

  const handleSearch = useCallback((value: string) => {
    setSearchQuery(value);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => { void loadMarket(value.trim()); }, DEBOUNCE_MS);
  }, [loadMarket]);

  const handleInstall = useCallback(async (code: string) => {
    setInstallingCode(code);
    try {
      await onInstall(code);
    } catch (err) {
      console.error('[McpAonePanel] 接入失败:', err);
      setError(err instanceof Error ? err.message : '接入失败');
    } finally {
      setInstallingCode(null);
    }
  }, [onInstall]);

  return (
    <>
      <div className="mcp-search-box">
        <span className="mcp-search-icon" aria-hidden="true">⌕</span>
        <input
          type="text"
          className="mcp-search-input"
          placeholder="搜索 Aone MCP..."
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
      ) : items.length > 0 ? (
        <div className="mcp-grid">
          {items.map((item) => {
            const installed = installedCodes.has(item.code);
            const installing = installingCode === item.code;
            return (
              <div key={item.code} className={`mcp-card${installed ? ' mcp-card--installed' : ''}`}>
                <span className="mcp-card-head">
                  <strong>{item.name}</strong>
                  {installed && <span className="mcp-card-badge">已接入</span>}
                </span>
                {item.description && <span className="mcp-card-desc">{item.description}</span>}
                <span className="mcp-card-meta">
                  {item.code}
                  {item.toolsCount > 0 ? ` · tools: ${item.toolsCount}` : ''}
                  {item.usageCount > 0 ? ` · ${item.usageCount} 次使用` : ''}
                </span>
                {!installed && (
                  <button
                    type="button"
                    className="mcp-card-install-btn"
                    disabled={installing}
                    onClick={() => handleInstall(item.code)}
                  >
                    {installing ? '接入中…' : '接入'}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <section className="capability-empty-state" aria-label="无数据">
          <h3>{searchQuery ? '未找到匹配结果' : '暂无 MCP 服务'}</h3>
          <p>{searchQuery ? '尝试其他关键词' : '请稍后再试。'}</p>
        </section>
      )}
    </>
  );
}

import type { SkillAoneMarketItem } from '../../preload/contracts/bootstrapPreloadApi';
import { useCallback, useEffect, useRef, useState } from 'react';
import { clientApi } from '../../clientApi';

function formatCount(n: number): string {
  if (n >= 10000) return `${(n / 1000).toFixed(1)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function AoneSkillCard({ item, installed, installing, onInstall }: { readonly item: SkillAoneMarketItem; readonly installed: boolean; readonly installing: boolean; readonly onInstall: (item: SkillAoneMarketItem) => void }) {
  const initial = (item.name || '?')[0].toUpperCase();
  return (
    <div className={`aone-skill-card${installed ? ' aone-skill-card--installed' : ''}`}>
      {installed && <span className="aone-skill-card-badge">已接入</span>}
      <div className="aone-skill-card-header">
        {item.icon
          ? <img className="aone-skill-card-icon" src={item.icon} alt="" />
          : <span className="aone-skill-card-avatar">{initial}</span>
        }
        <div className="aone-skill-card-title-row">
          <strong className="aone-skill-card-name">{item.name}</strong>
          <div className="aone-skill-card-stats">
            {typeof item.usageCount === 'number' && item.usageCount > 0 && (
              <span className="aone-skill-card-stat">⬇ {formatCount(item.usageCount)}</span>
            )}
            {typeof item.favoriteCount === 'number' && item.favoriteCount > 0 && (
              <span className="aone-skill-card-stat">☆ {formatCount(item.favoriteCount)}</span>
            )}
          </div>
        </div>
      </div>
      {item.description && <p className="aone-skill-card-desc">{item.description}</p>}
      <div className="aone-skill-card-footer">
        {item.platformName && <span className="aone-skill-card-tag">{item.platformName}</span>}
        {item.ownerName && <span className="aone-skill-card-owner">{item.ownerName}</span>}
      </div>
      {!installed && (
        <button
          className="aone-skill-card-install-btn"
          onClick={() => onInstall(item)}
          disabled={installing}
        >
          {installing ? '接入中…' : '接入'}
        </button>
      )}
    </div>
  );
}

const DEBOUNCE_MS = 400;
const PAGE_SIZE = 24;

export function SkillsAonePanel() {
  const [items, setItems] = useState<readonly SkillAoneMarketItem[]>([]);
  const [installedNames, setInstalledNames] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [needLogin, setNeedLogin] = useState(false);
  const [loginLoading, setLoginLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const pageRef = useRef(1);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seqRef = useRef(0);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async (keyword = '') => {
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    setNeedLogin(false);
    pageRef.current = 1;
    try {
      const [result, skills] = await Promise.all([
        clientApi.skillListAoneMarket({ keyword: keyword || undefined, rn: PAGE_SIZE, pn: 1 }),
        clientApi.listSkills(),
      ]);
      if (seq !== seqRef.current) return;
      setItems(result.items);
      setHasMore(result.pn < result.totalPages);
      setInstalledNames(new Set(skills.flatMap((s) => [s.skillId, s.name])));
    } catch (err: unknown) {
      if (seq !== seqRef.current) return;
      const msg = err instanceof Error ? err.message : '加载失败';
      if (msg === 'AONE_SSO_REQUIRED') {
        setNeedLogin(true);
      } else {
        setError(msg);
      }
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, []);

  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore) return;
    const seq = seqRef.current;
    const nextPage = pageRef.current + 1;
    setLoadingMore(true);
    try {
      const result = await clientApi.skillListAoneMarket({ keyword: searchQuery.trim() || undefined, rn: PAGE_SIZE, pn: nextPage });
      if (seq !== seqRef.current) return;
      pageRef.current = nextPage;
      setItems((prev) => [...prev, ...result.items]);
      setHasMore(result.pn < result.totalPages);
    } catch {
      // 加载更多失败静默处理
    } finally {
      if (seq === seqRef.current) setLoadingMore(false);
    }
  }, [loadingMore, hasMore, searchQuery]);

  useEffect(() => { void load(); }, [load]);

  // IntersectionObserver 触发加载下一页
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => { if (entries[0]?.isIntersecting) void loadMore(); },
      { rootMargin: '200px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [loadMore]);

  const handleSearch = useCallback((value: string) => {
    setSearchQuery(value);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => { void load(value.trim()); }, DEBOUNCE_MS);
  }, [load]);

  const handleLogin = useCallback(async () => {
    setLoginLoading(true);
    try {
      await clientApi.skillAoneLogin();
      void load(searchQuery.trim());
    } catch {
      setError('内网登录失败或已取消');
    } finally {
      setLoginLoading(false);
    }
  }, [load, searchQuery]);

  const [installingId, setInstallingId] = useState<string | null>(null);

  const handleInstall = useCallback(async (item: SkillAoneMarketItem) => {
    const name = item.code || item.name;
    if (!name) return;
    setInstallingId(item.id);
    try {
      await clientApi.skillInstallAone({ ...item, name });
      const skills = await clientApi.listSkills();
      setInstalledNames(new Set(skills.flatMap((s) => [s.skillId, s.name])));
    } catch (err) {
      console.error('[SkillsAonePanel] 接入失败:', err);
      setError(err instanceof Error ? err.message : '接入失败');
    } finally {
      setInstallingId(null);
    }
  }, []);

  return (
    <>
      <div className="skill-search-box">
        <span className="skill-search-icon" aria-hidden="true">⌕</span>
        <input
          type="text"
          className="skill-search-input"
          placeholder="搜索 Aone 内网技能..."
          value={searchQuery}
          onChange={(e) => handleSearch(e.target.value)}
        />
      </div>

      {loading ? (
        <div className="skill-loading">加载中…</div>
      ) : needLogin ? (
        <section className="capability-empty-state" aria-label="需要登录">
          <h3>需要内网登录</h3>
          <p>Aone 内网市场需要 SSO 认证，请点击下方按钮完成登录。</p>
          <button
            className="skill-aone-login-btn"
            onClick={handleLogin}
            disabled={loginLoading}
          >
            {loginLoading ? '登录中…' : '登录内网'}
          </button>
        </section>
      ) : error ? (
        <section className="capability-empty-state" aria-label="加载失败">
          <h3>加载失败</h3>
          <p>{error}</p>
        </section>
      ) : items.length === 0 ? (
        <section className="capability-empty-state" aria-label="无结果">
          <h3>{searchQuery ? '未找到匹配的技能' : 'Aone 内网暂无数据'}</h3>
          <p>{searchQuery ? '尝试其他关键词' : '请确认处于内网环境后重试。'}</p>
        </section>
      ) : (
        <div className="aone-skill-grid">
          {items.map((item) => (
            <AoneSkillCard
              key={item.id}
              item={item}
              installed={installedNames.has(item.code || item.name)}
              installing={installingId === item.id}
              onInstall={handleInstall}
            />
          ))}
          {/* 滚动哨兵 */}
          <div ref={sentinelRef} className="aone-skill-sentinel">
            {loadingMore && <span className="skill-loading">加载更多…</span>}
            {!hasMore && items.length > 0 && <span className="aone-skill-end">— 已加载全部 —</span>}
          </div>
        </div>
      )}
    </>
  );
}

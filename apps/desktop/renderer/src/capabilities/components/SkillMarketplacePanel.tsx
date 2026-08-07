import type { SkillHubCategory, SkillHubInstallScope, SkillHubMarketplaceEntry, SkillHubMarketplacePage, SkillHubMarketplaceSort } from '@peer-agent/protocol';
import { useEffect, useMemo, useState } from 'react';
import { Dropdown } from '../../app/components/Dropdown';
import { Overlay } from '../../app/components/Overlay';
import { clientApi } from '../../clientApi';

const PAGE_SIZE = 24;
const EMPTY_PAGE: SkillHubMarketplacePage = {
  page: 1,
  pageSize: PAGE_SIZE,
  total: 0,
  items: [],
  sync: { status: 'idle', nextPage: 1, total: 0, indexed: 0, updatedAt: null, error: null, skipped: 0, skippedReasons: {} },
};

const MARKET_FILTERS: readonly { readonly id: SkillHubMarketplaceSort; readonly label: string }[] = [
  { id: 'score', label: '全部' },
  { id: 'featured', label: '推荐精选' },
  { id: 'rising', label: '近期飙升' },
  { id: 'downloads', label: '下载量' },
  { id: 'stars', label: '收藏量' },
  { id: 'created', label: '最近上新' },
];

/** 远程分类字典未就绪时的中文回退（接口 name 优先）。 */
const SKILLHUB_CATEGORY_FALLBACK: Record<string, string> = {
  'pay-skill': 'Pay Skill',
  'office-efficiency': '办公效率',
  'content-creation': '内容创作',
  development: '开发编程',
  'dev-programming': '开发编程',
  'data-analysis': '数据分析',
  'design-media': '设计多媒体',
  professional: '行业专业',
  'ai-agent': 'AI Agent',
  'knowledge-management': '知识管理',
  'business-ops': '商业运营',
  education: '教育学习',
  'it-ops-security': 'IT 运维与安全',
  lifestyle: '生活服务',
  other: '其他',
};

function DownloadIcon() {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v12" />
      <path d="m7 11 5 5 5-5" />
      <path d="M5 21h14" />
    </svg>
  );
}

/** 优先展示 SkillHub iconUrl，失败时回退到字母头像。 */
function SkillIcon({
  name,
  iconUrl,
  className = 'skill-avatar',
}: {
  readonly name: string;
  readonly iconUrl?: string | null;
  readonly className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const letter = (name || '?').charAt(0).toUpperCase();
  const src = typeof iconUrl === 'string' ? iconUrl.trim() : '';
  useEffect(() => { setFailed(false); }, [src]);
  if (src && !failed) {
    return (
      <span className={`${className} skill-avatar--image`} aria-hidden="true">
        <img src={src} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
      </span>
    );
  }
  return (
    <span className={className} aria-hidden="true">{letter}</span>
  );
}

export function SkillMarketplacePanel({ onInstalled }: { readonly onInstalled?: () => void }) {
  const [result, setResult] = useState<SkillHubMarketplacePage>(EMPTY_PAGE);
  const [categories, setCategories] = useState<readonly SkillHubCategory[]>([]);
  const [keyword, setKeyword] = useState('');
  const [debouncedKeyword, setDebouncedKeyword] = useState('');
  const [page, setPage] = useState(1);
  const [category, setCategory] = useState('');
  const [sortBy, setSortBy] = useState<SkillHubMarketplaceSort>('score');
  const [selected, setSelected] = useState<SkillHubMarketplaceEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [installScope, setInstallScope] = useState<SkillHubInstallScope>('global');
  const [hasWorkspace, setHasWorkspace] = useState(false);

  const categoryNameByKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of categories) map.set(item.key, item.name);
    return map;
  }, [categories]);

  const categoryOptions = useMemo(
    () => [
      { value: '', label: '所有场景分类' },
      ...categories.map((item) => ({ value: item.key, label: item.name })),
    ],
    [categories],
  );

  const categoryLabel = (key: string | null | undefined) => {
    const value = (key ?? '').trim();
    if (!value) return '其他';
    return categoryNameByKey.get(value) ?? SKILLHUB_CATEGORY_FALLBACK[value] ?? value;
  };

  useEffect(() => {
    const timer = window.setTimeout(() => { setPage(1); setDebouncedKeyword(keyword.trim()); }, 250);
    return () => window.clearTimeout(timer);
  }, [keyword]);

  useEffect(() => {
    let cancelled = false;
    void clientApi.listSkillHubCategories()
      .then((items) => { if (!cancelled && Array.isArray(items)) setCategories(items); })
      .catch(() => { /* 分类字典缺失时回退显示原始 key */ });
    void clientApi.workspaceList()
      .then((result) => {
        if (cancelled) return;
        const active = typeof result?.activeWorkspace === 'string' && result.activeWorkspace.trim().length > 0;
        setHasWorkspace(active);
        if (!active) setInstallScope('global');
      })
      .catch(() => { if (!cancelled) setHasWorkspace(false); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void clientApi.querySkillHubSkills({ page, pageSize: PAGE_SIZE, keyword: debouncedKeyword, category, sortBy })
      .then((value) => { if (!cancelled) { setResult(value); setError(null); } })
      .catch(() => { if (!cancelled) setError('无法读取 SkillHub 本地索引'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [page, debouncedKeyword, category, sortBy]);

  useEffect(() => {
    if (!syncing && result.sync.status !== 'syncing') return;

    let cancelled = false;
    let queryInFlight = false;
    const queryCurrentPage = async () => {
      if (queryInFlight) return;
      queryInFlight = true;
      try {
        const next = await clientApi.querySkillHubSkills({
          page,
          pageSize: PAGE_SIZE,
          keyword: debouncedKeyword,
          category,
          sortBy,
        });
        if (cancelled) return;
        setResult(next);
        const nextPageCount = Math.max(1, Math.ceil(next.total / PAGE_SIZE));
        if (page > nextPageCount) setPage(nextPageCount);
      } catch {
        if (!cancelled) setError('无法刷新 SkillHub 本地索引');
      } finally {
        queryInFlight = false;
      }
    };

    void queryCurrentPage();
    const timer = window.setInterval(() => { void queryCurrentPage(); }, 1_500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [page, debouncedKeyword, category, sortBy, syncing, result.sync.status]);

  const refresh = async () => {
    setSyncing(true); setError(null);
    try {
      const status = await clientApi.syncSkillHubSkills();
      const [next, nextCategories] = await Promise.all([
        clientApi.querySkillHubSkills({ page, pageSize: PAGE_SIZE, keyword: debouncedKeyword, category, sortBy }),
        clientApi.listSkillHubCategories().catch(() => categories),
      ]);
      setResult({ ...next, sync: status });
      if (Array.isArray(nextCategories)) setCategories(nextCategories);
    } catch {
      const next = await clientApi.querySkillHubSkills({ page, pageSize: PAGE_SIZE, keyword: debouncedKeyword, category, sortBy }).catch(() => null);
      if (next) setResult(next);
      setError(next?.sync.indexed
        ? `SkillHub 同步暂停，继续显示已索引的 ${next.sync.indexed.toLocaleString()} 条记录`
        : 'SkillHub 暂时无法同步，请稍后重试');
    } finally { setSyncing(false); }
  };

  const install = async (entry: SkillHubMarketplaceEntry) => {
    if (installScope === 'workspace' && !hasWorkspace) {
      setError('当前没有打开工作区，请先选择工作区或改装到全局');
      return;
    }
    setInstalling(entry.catalogId); setError(null);
    try {
      const value = await clientApi.installSkillHubSkill({
        namespace: entry.namespace,
        slug: entry.slug,
        version: entry.version,
        scope: installScope,
      });
      if (!value.ok) throw new Error(value.error || 'install_failed');
      onInstalled?.(); setSelected(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('workspace_required')) {
        setError('当前没有打开工作区，无法安装到工作区');
      } else {
        setError('安装失败：签名、内容哈希或安装包校验未通过');
      }
    } finally { setInstalling(null); }
  };

  const totalPages = Math.max(1, Math.ceil(result.total / PAGE_SIZE));
  const syncActive = syncing || result.sync.status === 'syncing';
  const skippedText = result.sync.skipped > 0 ? ` · 跳过 ${result.sync.skipped.toLocaleString()} 条异常记录` : '';
  const syncText = syncActive
    ? `正在同步 ${result.sync.indexed.toLocaleString()} / ${result.sync.total.toLocaleString()}${skippedText}`
    : result.sync.status === 'error'
      ? `同步已暂停 · 已索引 ${result.sync.indexed.toLocaleString()}${skippedText}`
      : result.sync.updatedAt
        ? `已索引 ${result.sync.indexed.toLocaleString()}${skippedText} · ${new Date(result.sync.updatedAt).toLocaleString()}`
        : result.sync.indexed > 0
          ? `部分索引 ${result.sync.indexed.toLocaleString()}${skippedText}`
          : '正在建立本地索引';

  return (
    <section className="skill-marketplace" aria-label="Skill 市场">
      <div className="skill-marketplace-toolbar">
        <div className="skill-marketplace-controls">
          <input aria-label="搜索 SkillHub" type="search" placeholder="搜索名称、描述或分类" value={keyword} onChange={(event) => setKeyword(event.target.value)} />
          <div className="skill-marketplace-category-select">
            <Dropdown
              value={category}
              options={categoryOptions}
              ariaLabel="所有场景分类"
              onChange={(value) => { setPage(1); setCategory(value); }}
            />
          </div>
          <button type="button" className="skill-marketplace-install" disabled={syncActive} onClick={() => void refresh()}>{syncActive ? '同步中…' : '同步'}</button>
        </div>
      </div>
      <div className="skill-marketplace-filters" role="tablist" aria-label="市场筛选">
        {MARKET_FILTERS.map((filter) => (
          <button
            key={filter.id}
            type="button"
            role="tab"
            aria-selected={sortBy === filter.id}
            className={sortBy === filter.id ? 'is-active' : undefined}
            onClick={() => { setPage(1); setSortBy(filter.id); }}
          >
            {filter.label}
          </button>
        ))}
      </div>
      <div className="skill-marketplace-sync" role="status"><span>{syncText}</span><span>远程总量 {result.sync.total.toLocaleString()} · 当前结果 {result.total.toLocaleString()}</span></div>
      {error ? <p className="skill-marketplace-error" role="alert">{error}</p> : null}
      {loading ? <p className="skill-marketplace-empty">正在读取本地索引…</p> : null}
      {!loading && result.items.length === 0 ? <p className="skill-marketplace-empty">{syncActive ? '正在同步首批 Skill，请稍候…' : '没有匹配的 Skill。'}</p> : null}
      <div className="skill-marketplace-grid">
        {result.items.map((entry) => (
          <article className="skill-marketplace-card" key={entry.catalogId}>
            {/* 标题+描述合并为一个可点击区域，避免描述区单独 button 产生焦点条 */}
            <button type="button" className="skill-marketplace-card-body" onClick={() => setSelected(entry)}>
              <span className="skill-marketplace-card-heading">
                <SkillIcon name={entry.name} iconUrl={entry.iconUrl} />
                <span>
                  <strong>{entry.name}</strong>
                  <small>{entry.namespace} · v{entry.version}</small>
                </span>
              </span>
              <p>{entry.description || entry.descriptionOriginal || '暂无描述'}</p>
            </button>
            <div className="skill-marketplace-card-footer">
              <span className="skill-marketplace-tags">
                <em className="skill-marketplace-tag-category">{categoryLabel(entry.category)}</em>
                <em className="skill-marketplace-tag-downloads">
                  <DownloadIcon />
                  <span>{entry.downloads.toLocaleString()}</span>
                </em>
                {entry.verified ? <em>已认证</em> : null}
              </span>
              <button type="button" className="skill-marketplace-install" onClick={() => setSelected(entry)}>安装</button>
            </div>
          </article>
        ))}
      </div>
      <nav className="skill-marketplace-pagination" aria-label="市场分页">
        <button type="button" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>上一页</button>
        <span>第 {page.toLocaleString()} / {totalPages.toLocaleString()} 页</span>
        <button type="button" disabled={page >= totalPages} onClick={() => setPage((value) => Math.min(totalPages, value + 1))}>下一页</button>
      </nav>
      {selected ? (
        <Overlay onClose={() => setSelected(null)} ariaLabel={selected.name} panelClassName="skill-marketplace-detail">
          {({ requestClose }) => (<>
            <header className="skill-detail-header"><SkillIcon name={selected.name} iconUrl={selected.iconUrl} className="skill-avatar skill-detail-avatar" /><div className="skill-detail-heading"><div className="skill-detail-title-row"><h2>{selected.name}</h2><span className="skill-scope-badge">SkillHub</span></div><p>{selected.description || selected.descriptionOriginal}</p></div><button type="button" className="skill-detail-close" aria-label="关闭" onClick={requestClose}>×</button></header>
            <div className="skill-detail-meta"><span>{categoryLabel(selected.category)}</span><span>v{selected.version}</span><code>{selected.namespace}/{selected.slug}</code></div>
            <div className="skill-detail-content">
              <section className="skill-detail-when">
                <h3>来源与完整性</h3>
                <p>安装时按此 namespace、slug 和 version 下载，并验证 SkillHub Ed25519 平台签名、ZIP MD5 与 v1 内容哈希。</p>
              </section>
              <div className="skill-marketplace-metrics" aria-label="市场统计">
                <span className="skill-marketplace-metric">
                  <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 3v12" />
                    <path d="m7 11 5 5 5-5" />
                    <path d="M5 21h14" />
                  </svg>
                  <em>下载</em>
                  <strong>{selected.downloads.toLocaleString()}</strong>
                </span>
                <span className="skill-marketplace-metric">
                  <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 3 4 7v10l8 4 8-4V7l-8-4Z" />
                    <path d="m4 7 8 4 8-4" />
                    <path d="M12 11v10" />
                  </svg>
                  <em>安装</em>
                  <strong>{selected.installs.toLocaleString()}</strong>
                </span>
                <span className="skill-marketplace-metric">
                  <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1L12 17.8 6.6 19.8l1-6.1L3.2 9.4l6.1-.9L12 3Z" />
                  </svg>
                  <em>星标</em>
                  <strong>{selected.stars.toLocaleString()}</strong>
                </span>
                </div>
              <div className="skill-marketplace-install-row">
                <div className="skill-marketplace-install-actions">
                  <span className="skill-marketplace-install-label">安装位置</span>
                  <div className="skill-marketplace-install-scope" role="radiogroup" aria-label="安装位置">
                    <button
                      type="button"
                      role="radio"
                      aria-checked={installScope === 'global'}
                      className={installScope === 'global' ? 'is-active' : undefined}
                      onClick={() => setInstallScope('global')}
                    >
                      全局
                    </button>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={installScope === 'workspace'}
                      className={installScope === 'workspace' ? 'is-active' : undefined}
                      disabled={!hasWorkspace}
                      title={hasWorkspace ? '安装到当前工作区 skills/' : '当前没有打开工作区'}
                      onClick={() => setInstallScope('workspace')}
                    >
                      当前工作区
                    </button>
                  </div>
                </div>
                <button
                  type="button"
                  className="skill-marketplace-install skill-marketplace-install--primary"
                  disabled={installing === selected.catalogId || (installScope === 'workspace' && !hasWorkspace)}
                  onClick={() => void install(selected)}
                >
                  {installing === selected.catalogId
                    ? '正在校验并安装…'
                    : installScope === 'workspace'
                      ? '验证并安装到工作区'
                      : '验证并安装到全局'}
                </button>
              </div>
            </div>
          </>)}
        </Overlay>
      ) : null}
    </section>
  );
}

import type { QoderInstallScope, QoderMarketplaceEntry, QoderMarketplacePage, QoderMarketplaceSkillDetail, QoderMarketplaceSort } from '@peer-agent/protocol';
import { useEffect, useState } from 'react';
import { Overlay } from '../../app/components/Overlay';
import { clientApi } from '../../clientApi';

const PAGE_SIZE = 20;
const EMPTY_PAGE: QoderMarketplacePage = {
  currentPage: 1,
  nextPage: null,
  lastPage: 1,
  pageSize: PAGE_SIZE,
  totalSize: 0,
  items: [],
};

const SORT_FILTERS: readonly { readonly id: QoderMarketplaceSort; readonly label: string }[] = [
  { id: 'hot', label: '热门' },
  { id: 'latest', label: '最新' },
];

function formatInstallError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (message.includes('qoder_api_error_')) return '无法访问 Qoder 市场，请稍后重试';
  if (message.includes('qoder_zip_size_invalid')) return '安装包超出大小限制';
  if (message.includes('qoder_download_error_')) return '下载安装包失败，请稍后重试';
  if (message.includes('skill_already_installed')) return '该 Skill 已安装';
  if (message.includes('zip') || message.includes('archive')) return '安装包解析失败';
  return '安装失败，请稍后重试';
}

function SkillAvatar({ name, iconUrl }: { readonly name: string; readonly iconUrl: string | null }) {
  const [failed, setFailed] = useState(false);
  const className = 'skill-marketplace-avatar';
  const letter = (name || '?').trim().charAt(0).toUpperCase() || '?';
  if (iconUrl && !failed) {
    return (
      <span className={`${className} skill-avatar--image`} aria-hidden="true">
        <img src={iconUrl} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
      </span>
    );
  }
  return <span className={className} aria-hidden="true">{letter}</span>;
}

function DownloadIcon() {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v12" />
      <path d="m7 11 5 5 5-5" />
      <path d="M5 21h14" />
    </svg>
  );
}

function displayCount(value: number): string {
  if (value >= 10000) return `${(value / 10000).toFixed(1)} 万`;
  return value.toLocaleString();
}

function summarizeTree(node: { readonly files?: readonly unknown[] } | null): string {
  if (!node || !Array.isArray(node.files)) return '';
  const total = node.files.length;
  return total > 0 ? `${total} 个文件` : '';
}

export function QoderMarketplacePanel({ onInstalled }: { readonly onInstalled?: () => void }) {
  const [result, setResult] = useState<QoderMarketplacePage>(EMPTY_PAGE);
  const [keyword, setKeyword] = useState('');
  const [debouncedKeyword, setDebouncedKeyword] = useState('');
  const [page, setPage] = useState(1);
  const [sortBy, setSortBy] = useState<QoderMarketplaceSort>('hot');
  const [selected, setSelected] = useState<QoderMarketplaceEntry | null>(null);
  const [detail, setDetail] = useState<(QoderMarketplaceSkillDetail & { readonly skillMd: string | null }) | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [installScope, setInstallScope] = useState<QoderInstallScope>('global');
  const [hasWorkspace, setHasWorkspace] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => { setPage(1); setDebouncedKeyword(keyword.trim()); }, 300);
    return () => window.clearTimeout(timer);
  }, [keyword]);

  useEffect(() => {
    let cancelled = false;
    void clientApi.workspaceList()
      .then((value) => {
        if (cancelled) return;
        const active = Array.isArray(value?.workspaces) && value.workspaces.filter((workspace: { readonly active?: boolean }) => workspace.active).length > 0;
        setHasWorkspace(Boolean(active));
        if (!active) setInstallScope('global');
      })
      .catch(() => { if (!cancelled) setHasWorkspace(false); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void clientApi.queryQoderSkills({ page, pageSize: PAGE_SIZE, keyword: debouncedKeyword, sortBy })
      .then((value) => { if (!cancelled) { setResult(value); setError(null); } })
      .catch(() => { if (!cancelled) setError('无法访问 Qoder 市场'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [page, debouncedKeyword, sortBy]);

  useEffect(() => {
    if (!selected) { setDetail(null); setDetailLoading(false); return; }
    let cancelled = false;
    setDetailLoading(true);
    setInstallError(null);
    void clientApi.getQoderSkillDetail({ skillId: selected.skillId })
      .then((value) => { if (!cancelled) setDetail(value); })
      .catch(() => { if (!cancelled) setInstallError('无法读取 Skill 详情'); })
      .finally(() => { if (!cancelled) setDetailLoading(false); });
    return () => { cancelled = true; };
  }, [selected]);

  const totalPages = Math.max(1, result.lastPage);

  const closeSelected = () => {
    setSelected(null);
    setDetail(null);
    setInstallError(null);
  };

  const chooseInstallScope = (scope: QoderInstallScope) => {
    if (scope === 'workspace' && !hasWorkspace) return;
    setInstallScope(scope);
  };

  const install = async (entry: QoderMarketplaceEntry) => {
    setInstallError(null);
    setInstalling(entry.skillId);
    try {
      await clientApi.installQoderSkill({ skillId: entry.skillId, scope: installScope, iconUrl: entry.iconUrl });
      setInstalling(null);
      closeSelected();
      onInstalled?.();
    } catch (cause) {
      setInstalling(null);
      setInstallError(formatInstallError(cause));
    }
  };

  const installSummary = (entry: QoderMarketplaceEntry): string => installing === entry.skillId ? '正在安装…' : '安装';

  return (
    <section className="skill-marketplace" aria-label="Qoder 市场">
      <div className="skill-marketplace-toolbar">
        <div className="skill-marketplace-controls">
          <input aria-label="搜索 Qoder 市场" type="search" placeholder="搜索 43,000+ 个 Qoder 技能" value={keyword} onChange={(event) => setKeyword(event.target.value)} />
        </div>
      </div>
      <div className="skill-marketplace-filters" role="tablist" aria-label="市场排序">
        {SORT_FILTERS.map((filter) => (
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
      <div className="skill-marketplace-sync" role="status">
        <span>qoder.com 官方市场 · 服务端实时搜索</span>
        <span>共 {result.totalSize.toLocaleString()} 个 Skill · 当前第 {page.toLocaleString()} / {totalPages.toLocaleString()} 页</span>
      </div>
      {error ? <p className="skill-marketplace-error" role="alert">{error}</p> : null}
      {loading ? <p className="skill-marketplace-empty">正在搜索 Qoder 市场…</p> : null}
      {!loading && result.items.length === 0 ? <p className="skill-marketplace-empty">没有匹配的 Skill。</p> : null}
      <div className="skill-marketplace-grid">
        {result.items.map((entry) => (
          <article key={entry.skillId} className="skill-marketplace-card">
            <button type="button" className="skill-marketplace-card-body" onClick={() => setSelected(entry)}>
              <span className="skill-marketplace-card-heading">
                <SkillAvatar name={entry.nameCn || entry.name} iconUrl={entry.iconUrl} />
                <span>
                  <strong>{entry.nameCn || entry.name}</strong>
                  <small>{entry.authorName || entry.author || 'qoder.com'}{entry.category ? ` · ${entry.category}` : ''}</small>
                </span>
              </span>
              <p>{entry.descriptionCn || entry.description || '暂无描述'}</p>
            </button>
            <div className="skill-marketplace-card-footer">
              <span className="skill-marketplace-tags">
                {entry.category ? <em className="skill-marketplace-tag-category">{entry.category}</em> : null}
                <em className="skill-marketplace-tag-downloads">
                  <DownloadIcon />
                  <span>{displayCount(entry.installCount)}</span>
                </em>
              </span>
              <button type="button" className="skill-marketplace-install" disabled={installing === entry.skillId} onClick={() => setSelected(entry)}>{installSummary(entry)}</button>
            </div>
          </article>
        ))}
      </div>
      <nav className="skill-marketplace-pagination" aria-label="Qoder 市场分页">
        <button type="button" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>上一页</button>
        <span>第 {page.toLocaleString()} / {totalPages.toLocaleString()} 页</span>
        <button type="button" disabled={page >= totalPages} onClick={() => setPage((value) => Math.min(totalPages, value + 1))}>下一页</button>
      </nav>
      {selected ? (
        <Overlay onClose={closeSelected} ariaLabel={`${selected.nameCn || selected.name} 详情`}>
          {(() => {
            const description = detail?.descriptionCn || detail?.description || selected.descriptionCn || selected.description;
            return (<>
              <div className="skill-marketplace-detail-header">
                <SkillAvatar name={selected.nameCn || selected.name} iconUrl={detail?.iconUrl ?? selected.iconUrl} />
                <div>
                  <h2>{selected.nameCn || selected.name}</h2>
                  <p className="skill-marketplace-detail-subtitle">
                    {selected.authorName || selected.author || 'qoder.com'}
                    {detail?.version && detail.version !== 'unknown' ? ` · v${detail.version}` : ''}
                    {selected.category ? ` · ${selected.category}` : ''}
                  </p>
                </div>
              </div>
              <p className="skill-marketplace-detail-description">{description || '暂无描述'}</p>
              <div className="skill-marketplace-metrics" aria-label="市场统计">
                <span className="skill-marketplace-metric">
                  <DownloadIcon />
                  <em>安装量</em>
                  <strong>{selected.installCount.toLocaleString()}</strong>
                </span>
                <span className="skill-marketplace-metric">
                  <DownloadIcon />
                  <em>文件</em>
                  <strong>{summarizeTree(detail?.fileTree ?? null) || '—'}</strong>
                </span>
              </div>
              {detailLoading ? <p className="skill-marketplace-empty">正在读取详情…</p> : null}
              {detail?.skillMd ? (
                <section className="skill-marketplace-detail-readme" aria-label="SKILL.md">
                  <h3>SKILL.md</h3>
                  <pre>{detail.skillMd.slice(0, 4000)}{detail.skillMd.length > 4000 ? '\n…' : ''}</pre>
                </section>
              ) : null}
              {detail?.githubPath ? (
                <section className="skill-marketplace-detail-source" aria-label="来源">
                  <h3>来源</h3>
                  <p className="skill-marketplace-detail-source-note">
                    来自 qoder.com 官方市场（apphub）。{detail.githubPath ? '上游仓库：' : ''}
                    {detail.githubPath ? <a href={detail.githubPath} target="_blank" rel="noreferrer">{detail.githubPath}</a> : null}
                  </p>
                </section>
              ) : null}
              <div className="skill-marketplace-install-row">
                <div className="skill-marketplace-install-actions">
                  <span className="skill-marketplace-install-label">安装位置</span>
                  <div className="skill-marketplace-install-scope" role="radiogroup" aria-label="安装位置">
                    <button
                      type="button"
                      role="radio"
                      aria-checked={installScope === 'global'}
                      className={installScope === 'global' ? 'is-active' : undefined}
                      onClick={() => chooseInstallScope('global')}
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
                      onClick={() => chooseInstallScope('workspace')}
                    >
                      当前工作区
                    </button>
                  </div>
                </div>
                <button
                  type="button"
                  className="skill-marketplace-install skill-marketplace-install--primary"
                  disabled={installing === selected.skillId || (installScope === 'workspace' && !hasWorkspace)}
                  onClick={() => void install(selected)}
                >
                  {installing === selected.skillId
                    ? '正在下载并安装…'
                    : installScope === 'workspace'
                      ? '下载并安装到工作区'
                      : '下载并安装到全局'}
                </button>
                {installError ? (
                  <p className="skill-marketplace-install-error" role="alert">{installError}</p>
                ) : null}
              </div>
            </>);
          })()}
        </Overlay>
      ) : null}
    </section>
  );
}

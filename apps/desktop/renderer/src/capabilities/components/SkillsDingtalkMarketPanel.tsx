import type { SkillDingtalkMarketItem } from '../../preload/contracts/bootstrapPreloadApi';
import { useCallback, useEffect, useRef, useState } from 'react';
import { clientApi } from '../../clientApi';

function SkillMarketCard({ item, installed, installing, onInstall }: {
  readonly item: SkillDingtalkMarketItem;
  readonly installed: boolean;
  readonly installing: boolean;
  readonly onInstall: (item: SkillDingtalkMarketItem) => void;
}) {
  return (
    <div className={`skill-market-card${installed ? ' skill-market-card--installed' : ''}`}>
      {item.icon && <img className="skill-market-card-icon" src={item.icon} alt="" />}
      <div className="skill-market-card-body">
        <strong className="skill-market-card-name">{item.label || item.name}</strong>
        {((item.categories && item.categories.length > 0) || (item.tags && item.tags.length > 0)) && (
          <div className="skill-market-card-tags">
            {item.categories?.map((cat) => <span key={cat.categoryCode} className="skill-market-tag">{cat.categoryName}</span>)}
            {item.tags?.map((tag) => <span key={tag} className="skill-market-tag">{tag}</span>)}
          </div>
        )}
        {item.description && <p className="skill-market-card-desc">{item.description}</p>}
        <div className="skill-market-card-footer">
          <div className="skill-market-card-meta">
            {item.developerName && <span className="skill-market-card-dev">{item.developerName}</span>}
          </div>
          {item.dependentServices && item.dependentServices.length > 0 && (
            <div className="skill-market-card-services">
              {item.dependentServices.map((svc) => (
                <span key={svc.toolId} className="skill-market-service-icon">
                  {svc.icon
                    ? <img src={svc.icon} alt={svc.name} title={[svc.name, svc.description].filter(Boolean).join('\n')} />
                    : <span className="skill-market-service-placeholder" title={[svc.name, svc.description].filter(Boolean).join('\n')}>{svc.name.charAt(0)}</span>}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
      {installed && <span className="skill-market-card-badge">已接入</span>}
      {!installed && (
        <button
          type="button"
          className="skill-market-card-install-btn"
          disabled={installing}
          onClick={(e) => { e.stopPropagation(); onInstall(item); }}
        >
          {installing ? '接入中…' : '接入'}
        </button>
      )}
    </div>
  );
}

const DEBOUNCE_MS = 400;

export function SkillsDingtalkMarketPanel() {
  const [items, setItems] = useState<readonly SkillDingtalkMarketItem[]>([]);
  const [installedNames, setInstalledNames] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [installingId, setInstallingId] = useState<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seqRef = useRef(0);

  const load = useCallback(async (keyword = '') => {
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    try {
      const [result, skills] = await Promise.all([
        clientApi.skillListDingtalkMarket({ keyword: keyword || undefined, pageSize: 24 }),
        clientApi.listSkills(),
      ]);
      if (seq !== seqRef.current) return;
      setItems(result.values);
      setInstalledNames(new Set(skills.flatMap((s) => [s.skillId, s.name])));
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
    timerRef.current = setTimeout(() => { void load(value.trim()); }, DEBOUNCE_MS);
  }, [load]);

  const handleInstall = useCallback(async (item: SkillDingtalkMarketItem) => {
    if (!item.skillId) return;
    setInstallingId(item.id);
    try {
      await clientApi.skillInstallDingtalk({ skillId: item.skillId, name: item.name });
      const skills = await clientApi.listSkills();
      setInstalledNames(new Set(skills.flatMap((s) => [s.skillId, s.name])));
    } catch (err) {
      console.error('[SkillsDingtalkMarketPanel] 接入失败:', err);
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
          placeholder="搜索技能..."
          value={searchQuery}
          onChange={(e) => handleSearch(e.target.value)}
        />
      </div>

      {loading ? (
        <div className="skill-loading">加载中…</div>
      ) : error ? (
        <section className="capability-empty-state" aria-label="加载失败">
          <h3>加载失败</h3>
          <p>{error}</p>
        </section>
      ) : items.length === 0 ? (
        <section className="capability-empty-state" aria-label="无结果">
          <h3>{searchQuery ? '未找到匹配的技能' : '钉钉市场暂无数据'}</h3>
          <p>{searchQuery ? '尝试其他关键词' : '请稍后再试。'}</p>
        </section>
      ) : (
        <div className="skill-market-grid">
          {items.map((item) => (
            <SkillMarketCard
              key={item.id}
              item={item}
              installed={installedNames.has(item.skillId) || installedNames.has(item.name)}
              installing={installingId === item.id}
              onInstall={handleInstall}
            />
          ))}
        </div>
      )}
    </>
  );
}

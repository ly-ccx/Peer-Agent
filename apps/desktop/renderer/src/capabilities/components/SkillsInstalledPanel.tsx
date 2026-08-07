import type { AvailableSkillSummary, SkillSummary } from '@peer-agent/protocol';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { clientApi } from '../../clientApi';
import { Switch } from '../../ui/boolean-controls';
import { SkillDetailDialog } from './SkillDetailDialog';

/** 优先展示 skill.iconUrl，失败时回退到字母头像。 */
function SkillIcon({
  name,
  iconUrl,
}: {
  readonly name: string;
  readonly iconUrl?: string | null;
}) {
  const [failed, setFailed] = useState(false);
  const letter = (name || '?').charAt(0).toUpperCase();
  const src = typeof iconUrl === 'string' ? iconUrl.trim() : '';
  if (!src || failed) {
    return <span className="skill-avatar" aria-hidden="true">{letter}</span>;
  }
  return (
    <span className="skill-avatar skill-avatar--image" aria-hidden="true">
      <img src={src} alt="" onError={() => setFailed(true)} />
    </span>
  );
}

function sourceBadgeLabel(source?: string | null): string | null {
  const value = typeof source === 'string' ? source.trim() : '';
  if (!value) return null;
  if (value === 'skillhub') return 'SkillHub';
  return value;
}

function SkillSection({
  title,
  description,
  skills,
  onSelect,
  onToggle,
}: {
  readonly title: string;
  readonly description: string;
  readonly skills: readonly SkillSummary[];
  readonly onSelect: (skill: SkillSummary) => void;
  readonly onToggle: (skill: SkillSummary) => void;
}) {
  return (
    <section className="skill-scope-section">
      <header className="skill-scope-header">
        <div>
          <h3>{title}</h3>
          <p>{description}</p>
        </div>
        <span>{skills.length}</span>
      </header>
      {skills.length === 0 ? (
        <div className="skill-scope-empty">当前工作空间没有项目级 Skill</div>
      ) : (
      <div className="skill-grid">
        {skills.map((skill) => (
          <article
            key={skill.skillId}
            className={`skill-card ${skill.enabled ? '' : 'disabled'}`}
            tabIndex={0}
            role="button"
            onClick={() => onSelect(skill)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onSelect(skill);
              }
            }}
          >
            <SkillIcon name={skill.name} iconUrl={skill.iconUrl} />
            <div className="skill-card-body">
              <div className="skill-card-title-row">
                <div className="skill-card-title-main">
                  <strong className="skill-card-name">{skill.name}</strong>
                  {sourceBadgeLabel(skill.source) ? (
                    <span className="skill-source-badge">{sourceBadgeLabel(skill.source)}</span>
                  ) : null}
                </div>
                <span className="skill-card-actions" onClick={(event) => event.stopPropagation()}>
                  <Switch checked={skill.enabled} onCheckedChange={() => onToggle(skill)} aria-label={`${skill.name} ${skill.enabled ? '已启用' : '已停用'}`} />
                </span>
              </div>
              <span className="skill-card-desc">{skill.description || '暂无描述'}</span>
            </div>
          </article>
        ))}
      </div>
      )}
    </section>
  );
}

export function SkillsInstalledPanel({ onSkillsCountChange }: {
  readonly onSkillsCountChange?: (count: number) => void;
}) {
  const [skills, setSkills] = useState<readonly SkillSummary[]>([]);
  const [available, setAvailable] = useState<readonly AvailableSkillSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [selectedSkill, setSelectedSkill] = useState<SkillSummary | null>(null);
  const [activeWorkspace, setActiveWorkspace] = useState<string | null>(null);

  const loadSkills = useCallback(async () => {
    try {
      const list = await clientApi.listSkills();
      setSkills(list);
      onSkillsCountChange?.(list.length);
    } finally {
      setLoading(false);
    }
  }, [onSkillsCountChange]);

  const loadAvailable = useCallback(async () => {
    try { setAvailable(await clientApi.listAvailableSkills()); }
    catch { setAvailable([]); }
  }, []);

  const loadWorkspace = useCallback(async () => {
    const result = await clientApi.workspaceList();
    setActiveWorkspace(result.activeWorkspace);
  }, []);

  useEffect(() => {
    void loadSkills();
    void loadAvailable();
    void loadWorkspace();
  }, [loadSkills, loadAvailable, loadWorkspace]);

  useEffect(() => clientApi.onWorkspacesChanged(() => {
    setSelectedSkill(null);
    void loadSkills();
    void loadWorkspace();
  }), [loadSkills, loadWorkspace]);

  const filteredSkills = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return skills;
    return skills.filter((skill) => skill.name.toLowerCase().includes(query)
      || skill.skillId.toLowerCase().includes(query)
      || skill.description?.toLowerCase().includes(query));
  }, [skills, searchQuery]);

  const workspaceSkills = useMemo(
    () => filteredSkills.filter((skill) => skill.scope === 'workspace'),
    [filteredSkills],
  );
  const globalSkills = useMemo(
    () => filteredSkills.filter((skill) => skill.scope !== 'workspace'),
    [filteredSkills],
  );
  const borrowable = useMemo(() => available.filter((skill) => !skill.linked), [available]);

  const setSkillEnabled = useCallback(async (skillId: string, enabled: boolean) => {
    const updated = enabled
      ? await clientApi.enableSkill(skillId)
      : await clientApi.disableSkill(skillId);
    setSkills(updated);
    setSelectedSkill((current) => current?.skillId === skillId ? { ...current, enabled } : current);
  }, []);

  const uninstallSkill = useCallback(async (skillId: string) => {
    const result = await clientApi.uninstallSkill(skillId);
    if (!result.ok) {
      const reason = result.error === 'workspace-skill-not-uninstallable'
        ? '项目级 Skill 不能从这里删除源文件'
        : result.error === 'path-escape'
          ? '拒绝删除：路径不在用户安装目录内'
          : result.error === 'not-found'
            ? '未找到可卸载的安装'
            : result.error ?? '未知错误';
      throw new Error(reason);
    }
    // 刷新列表，但不要在这里硬卸载详情弹窗；由 SkillDetailDialog 走 Overlay requestClose 退场。
    await Promise.all([loadSkills(), loadAvailable()]);
  }, [loadAvailable, loadSkills]);

  const handleLink = useCallback(async (skill: AvailableSkillSummary) => {
    setBusyId(skill.skillId);
    setLinkError(null);
    try {
      const result = await clientApi.linkSkill(skill.skillId);
      if (!result.ok) {
        setLinkError(`借用「${skill.name}」失败：${result.error ?? '未知错误'}`);
        return;
      }
      await Promise.all([loadSkills(), loadAvailable()]);
    } catch {
      setLinkError(`借用「${skill.name}」失败：调用异常`);
    } finally { setBusyId(null); }
  }, [loadSkills, loadAvailable]);

  if (loading) return <div className="skill-loading">加载中…</div>;

  return (
    <div className="skill-panel">
      {linkError ? <div className="skill-link-error" role="alert">{linkError}</div> : null}
      <input
        className="skill-search-input"
        type="search"
        value={searchQuery}
        onChange={(event) => setSearchQuery(event.target.value)}
        placeholder="搜索 Skills"
        aria-label="搜索 Skills"
      />

      {filteredSkills.length === 0 ? (
        <section className="skill-empty"><p>没有找到 Skill</p></section>
      ) : (
        <>
          <SkillSection
            title={`工作空间${activeWorkspace ? ` · ${activeWorkspace.split('/').filter(Boolean).at(-1)}` : ''}`}
            description={activeWorkspace ?? '尚未选择工作空间'}
            skills={workspaceSkills}
            onSelect={setSelectedSkill}
            onToggle={(skill) => { void setSkillEnabled(skill.skillId, !skill.enabled); }}
          />
          <SkillSection
            title="全局"
            description="安装在用户目录中，可挂载到任意工作空间"
            skills={globalSkills}
            onSelect={setSelectedSkill}
            onToggle={(skill) => { void setSkillEnabled(skill.skillId, !skill.enabled); }}
          />
        </>
      )}

      {borrowable.length > 0 ? (
        <section className="skill-borrow-section" aria-label="可借用技能">
          <div className="skill-borrow-header">
            <strong>可借用技能</strong>
            <span className="skill-borrow-hint">来自外部公共技能仓，借用后安装到全局</span>
          </div>
          <div className="skill-grid">
            {borrowable.map((skill) => (
              <div key={`${skill.sourceRoot}:${skill.skillId}`} className="skill-card borrowable">
                <SkillIcon name={skill.name} />
                <div className="skill-card-body">
                  <div className="skill-card-title-row">
                    <strong className="skill-card-name">{skill.name}</strong>
                    <span className="skill-card-actions">
                      <button type="button" className="skill-borrow-btn" disabled={busyId === skill.skillId} onClick={() => { void handleLink(skill); }}>
                        {busyId === skill.skillId ? '借用中…' : '借用'}
                      </button>
                    </span>
                  </div>
                  <span className="skill-card-desc">{skill.description || '暂无描述'}</span>
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {selectedSkill ? (
        <SkillDetailDialog
          skill={selectedSkill}
          onClose={() => setSelectedSkill(null)}
          onToggle={setSkillEnabled}
          onUninstall={uninstallSkill}
        />
      ) : null}
    </div>
  );
}

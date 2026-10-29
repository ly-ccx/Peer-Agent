import { createI18n } from '@peer-agent/i18n';
import { useResourceRead, useResourceActions } from '../../ui/resources/useResourceState';
import { ResourceFeedback } from '../../ui/resources/ResourceFeedback';
import { isImeKey } from '../../chat/state/compositionGuard';
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
  pending,
}: {
  readonly title: string;
  readonly description: string;
  readonly skills: readonly SkillSummary[];
  readonly onSelect: (skill: SkillSummary) => void;
  readonly onToggle: (skill: SkillSummary) => void;
  readonly pending: (skill: SkillSummary) => boolean;
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
        <div className="skill-scope-empty">当前机器人没有项目级 Skill</div>
      ) : (
      <div className="skill-grid">
        {skills.map((skill) => (
          <article
            key={`${skill.scope}:${skill.workspacePath ?? 'global'}:${skill.skillId}`}
            className={`skill-card ${skill.enabled ? '' : 'disabled'}`}
            tabIndex={0}
            role="button"
            onClick={() => onSelect(skill)}
            onKeyDown={(event) => {
              if (event.target !== event.currentTarget || isImeKey(event.nativeEvent)) return;
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
                  <Switch disabled={pending(skill)} checked={skill.enabled} onCheckedChange={() => onToggle(skill)} aria-label={`${skill.name} ${skill.enabled ? '已启用' : '已停用'}`} />
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
  const actions = useResourceActions('installed-skills');
  const i18n = useMemo(() => createI18n('zh-CN'), []);
  const reader = useResourceRead('installed-skills', async () => {
    const workspace = await clientApi.workspaceList();
    const list = await clientApi.listSkills(workspace.workspaces.map(row => row.path));
    return { list, workspaces: workspace.workspaces };
  });
  const availableReader = useResourceRead('available-skills', () => clientApi.listAvailableSkills());
  const [searchQuery, setSearchQuery] = useState('');
  const [linkError, setLinkError] = useState<string | null>(null);
  const [selectedSkill, setSelectedSkill] = useState<SkillSummary | null>(null);
  const skills = reader.value?.list ?? [];
  const workspaces = reader.value?.workspaces ?? [];
  const available = availableReader.value ?? [];

  const loadSkills = reader.reload, loadAvailable = availableReader.reload;
  useEffect(() => {
    if (!reader.value) return;
    onSkillsCountChange?.(reader.value.list.length);
  }, [reader.value, onSkillsCountChange]);

  useEffect(() => clientApi.onWorkspacesChanged(() => {
    setSelectedSkill(null);
    void loadSkills();
  }), [loadSkills]);

  const filteredSkills = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return skills;
    return skills.filter((skill) => skill.name.toLowerCase().includes(query)
      || skill.skillId.toLowerCase().includes(query)
      || skill.description?.toLowerCase().includes(query));
  }, [skills, searchQuery]);

  const workspaceGroups = useMemo(() => workspaces.map((workspace) => ({
    ...workspace,
    skills: filteredSkills.filter((skill) => skill.scope === 'workspace' && skill.workspacePath === workspace.path),
  })), [filteredSkills, workspaces]);
  const globalSkills = useMemo(
    () => filteredSkills.filter((skill) => skill.scope !== 'workspace'),
    [filteredSkills],
  );
  const borrowable = useMemo(() => available.filter((skill) => !skill.linked), [available]);

  const setSkillEnabled = useCallback(async (skillId: string, enabled: boolean, workspacePath?: string | null) => {
    const confirmed = await actions.run(JSON.stringify([skillId, workspacePath ?? null]), async () => {
      if (enabled) await clientApi.enableSkill(skillId, workspacePath);
      else await clientApi.disableSkill(skillId, workspacePath);
      const snapshot = reader.snapshot().value;
      if (snapshot) reader.accept({ ...snapshot, list: snapshot.list.map(skill =>
        skill.skillId === skillId && (skill.workspacePath ?? null) === (workspacePath ?? null) ? { ...skill, enabled } : skill) });
      setSelectedSkill(current => current?.skillId === skillId && (current.workspacePath ?? null) === (workspacePath ?? null)
        ? { ...current, enabled } : current);
    });
    if (!confirmed) throw Error('技能开关尚未确认，原状态已保留。');
  }, [actions.run, reader.accept, reader.snapshot]);

  const uninstallSkill = useCallback(async (skillId: string) => {
    const workspacePath = selectedSkill?.workspacePath ?? null;
    const result = await clientApi.uninstallSkill(skillId, workspacePath);
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
  }, [loadAvailable, loadSkills, selectedSkill?.workspacePath]);

  const handleLink = useCallback(async (skill: AvailableSkillSummary) => {
    await actions.run(`link:${skill.sourceRoot}:${skill.skillId}`, async () => {
      setLinkError(null);
      try {
        const result = await clientApi.linkSkill(skill.skillId);
        if (!result.ok) throw Error(result.error ?? '未知错误');
        await Promise.all([loadSkills(), loadAvailable()]);
      } catch (error) {
        setLinkError(`借用「${skill.name}」尚未确认：${error instanceof Error ? error.message : '调用异常'}`);
        throw error;
      }
    });
  }, [actions.run, loadSkills, loadAvailable]);

  return (
    <div className="skill-panel">
      <ResourceFeedback i18n={i18n} loading={reader.loading} error={reader.error} onReload={loadSkills} />
      <ResourceFeedback i18n={i18n} loading={availableReader.loading} error={availableReader.error} onReload={loadAvailable} />
      {skills.some(skill => actions.get(JSON.stringify([skill.skillId, skill.workspacePath ?? null])).error) ? <p className="ui-form-feedback is-error" role="alert">技能开关尚未确认，原状态已保留。请核对后重试。</p> : null}
      {linkError ? <div className="skill-link-error" role="alert">{linkError}</div> : null}
      <input
        className="ui-input skill-search-input"
        type="search"
        value={searchQuery}
        onChange={(event) => setSearchQuery(event.target.value)}
        placeholder="搜索 Skills"
        aria-label="搜索 Skills"
      />

      {!reader.loaded ? null : filteredSkills.length === 0 ? (
        <section className="skill-empty"><p>没有找到 Skill</p></section>
      ) : (
        <>
          {workspaceGroups.map((workspace) => (
            <SkillSection
              key={workspace.path}
              title={`机器人 · ${workspace.name || workspace.path.split('/').filter(Boolean).at(-1) || workspace.path}`}
              description={workspace.path}
              skills={workspace.skills}
              onSelect={setSelectedSkill}
              pending={skill => actions.get(JSON.stringify([skill.skillId, skill.workspacePath ?? null])).pending}
            onToggle={(skill) => { void setSkillEnabled(skill.skillId, !skill.enabled, skill.workspacePath).catch(() => {}); }}
            />
          ))}
          <SkillSection
            title="全局"
            description="安装在用户目录中，可挂载到任意机器人"
            skills={globalSkills}
            onSelect={setSelectedSkill}
            pending={skill => actions.get(JSON.stringify([skill.skillId, skill.workspacePath ?? null])).pending}
            onToggle={(skill) => { void setSkillEnabled(skill.skillId, !skill.enabled, null).catch(() => {}); }}
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
                      <button type="button" className="skill-borrow-btn" disabled={actions.get(`link:${skill.sourceRoot}:${skill.skillId}`).pending} onClick={() => { void handleLink(skill); }}>
                        {actions.get(`link:${skill.sourceRoot}:${skill.skillId}`).pending ? '借用中…' : '借用'}
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

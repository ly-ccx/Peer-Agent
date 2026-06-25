import type { AvailableSkillSummary, SkillSummary } from '@peer-agent/protocol';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { clientApi } from '../../clientApi';

function SkillAvatar({ name }: { readonly name: string }) {
  const letter = (name || '?').charAt(0).toUpperCase();
  return <span className="skill-avatar" aria-hidden="true">{letter}</span>;
}

function SkillToggle({
  enabled,
  onChange,
}: {
  readonly enabled: boolean;
  readonly onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      className={`skill-toggle ${enabled ? 'on' : 'off'}`}
      onClick={(e) => { e.stopPropagation(); onChange(!enabled); }}
    >
      <span className="skill-toggle-thumb" />
    </button>
  );
}

export function SkillsInstalledPanel({
  onSkillsCountChange,
}: {
  readonly onSkillsCountChange?: (count: number) => void;
}) {
  const [skills, setSkills] = useState<readonly SkillSummary[]>([]);
  const [available, setAvailable] = useState<readonly AvailableSkillSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);

  const loadSkills = useCallback(async () => {
    try {
      const list = await clientApi.listSkills();
      setSkills(list);
      onSkillsCountChange?.(list.length);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [onSkillsCountChange]);

  const loadAvailable = useCallback(async () => {
    try {
      const list = await clientApi.listAvailableSkills();
      setAvailable(list);
    } catch {
      // 借用来源不可用（如未安装 a1）时静默置空。
      setAvailable([]);
    }
  }, []);

  useEffect(() => {
    void loadSkills();
    void loadAvailable();
  }, [loadSkills, loadAvailable]);

  const filteredSkills = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return skills;
    return skills.filter(
      (s) => s.name.toLowerCase().includes(q)
        || s.skillId.toLowerCase().includes(q)
        || (s.description && s.description.toLowerCase().includes(q)),
    );
  }, [skills, searchQuery]);

  // 仅展示尚未 link 的可借技能（已 link 的会出现在上方已安装列表里）。
  const borrowable = useMemo(
    () => available.filter((a) => !a.linked),
    [available],
  );

  const handleToggle = useCallback(async (skill: SkillSummary) => {
    try {
      const updated = skill.enabled
        ? await clientApi.disableSkill(skill.skillId)
        : await clientApi.enableSkill(skill.skillId);
      setSkills(updated);
    } catch {
      // silent
    }
  }, []);

  const handleLink = useCallback(async (skill: AvailableSkillSummary) => {
    setBusyId(skill.skillId);
    setLinkError(null);
    try {
      const res = await clientApi.linkSkill(skill.skillId);
      if (!res.ok) {
        setLinkError(`借用「${skill.name}」失败：${res.error ?? '未知错误'}`);
        return;
      }
      await Promise.all([loadSkills(), loadAvailable()]);
    } catch {
      setLinkError(`借用「${skill.name}」失败：调用异常`);
    } finally {
      setBusyId(null);
    }
  }, [loadSkills, loadAvailable]);

  const handleUnlink = useCallback(async (skillId: string, name: string) => {
    setBusyId(skillId);
    setLinkError(null);
    try {
      const res = await clientApi.unlinkSkill(skillId);
      if (!res.ok) {
        setLinkError(`移除「${name}」失败：${res.error ?? '未知错误'}`);
        return;
      }
      await Promise.all([loadSkills(), loadAvailable()]);
    } catch {
      setLinkError(`移除「${name}」失败：调用异常`);
    } finally {
      setBusyId(null);
    }
  }, [loadSkills, loadAvailable]);

  if (loading) {
    return <div className="skill-loading">加载中…</div>;
  }

  return (
    <div className="skill-panel">
      {linkError ? <div className="skill-link-error" role="alert">{linkError}</div> : null}

      {filteredSkills.length === 0 ? (
        <section className="capability-empty-state" aria-label="暂无本地技能">
          <h3>{searchQuery ? '未找到匹配的技能' : '暂无本地技能'}</h3>
          <p>{searchQuery ? '尝试其他关键词搜索' : '点击「上传技能」安装 .zip 格式的个人技能包，或从下方「可借用技能」一键借用。'}</p>
        </section>
      ) : (
        <div className="skill-grid">
          {filteredSkills.map((skill) => (
            <div key={skill.skillId} className={`skill-card ${skill.enabled ? '' : 'disabled'}`}>
              <SkillAvatar name={skill.name} />
              <div className="skill-card-body">
                <div className="skill-card-title-row">
                  <strong className="skill-card-name">{skill.name}</strong>
                  <span className="skill-card-actions">
                    <SkillToggle enabled={skill.enabled} onChange={() => handleToggle(skill)} />
                  </span>
                </div>
                <span className="skill-card-desc">{skill.description || '暂无描述'}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {borrowable.length > 0 ? (
        <section className="skill-borrow-section" aria-label="可借用技能">
          <div className="skill-borrow-header">
            <strong>可借用技能</strong>
            <span className="skill-borrow-hint">来自 a1 公共技能仓，借用后在本地建立软链</span>
          </div>
          <div className="skill-grid">
            {borrowable.map((skill) => (
              <div key={skill.skillId} className="skill-card borrowable">
                <SkillAvatar name={skill.name} />
                <div className="skill-card-body">
                  <div className="skill-card-title-row">
                    <strong className="skill-card-name">{skill.name}</strong>
                    <span className="skill-card-actions">
                      <button
                        type="button"
                        className="skill-borrow-btn"
                        disabled={busyId === skill.skillId}
                        onClick={() => handleLink(skill)}
                      >
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
    </div>
  );
}

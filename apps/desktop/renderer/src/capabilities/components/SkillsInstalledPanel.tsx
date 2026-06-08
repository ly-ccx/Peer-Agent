import type { SkillSummary } from '@zeus-atlas/protocol';
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
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');

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

  useEffect(() => {
    void loadSkills();
  }, [loadSkills]);

  const filteredSkills = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return skills;
    return skills.filter(
      (s) => s.name.toLowerCase().includes(q)
        || s.skillId.toLowerCase().includes(q)
        || (s.description && s.description.toLowerCase().includes(q)),
    );
  }, [skills, searchQuery]);

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

  if (loading) {
    return <div className="skill-loading">加载中…</div>;
  }

  if (filteredSkills.length === 0) {
    return (
      <section className="capability-empty-state" aria-label="暂无本地技能">
        <h3>{searchQuery ? '未找到匹配的技能' : '暂无本地技能'}</h3>
        <p>{searchQuery ? '尝试其他关键词搜索' : '点击「上传技能」安装 .zip 格式的个人技能包，解压后须包含 SKILL.md。'}</p>
      </section>
    );
  }

  return (
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
  );
}

import { useState } from 'react';
import { formatDuration } from '../../state/format';
import type { SkillToolView } from '../../state/skillToolView';

export type SkillCapsuleCardProps = {
  readonly skill: SkillToolView;
  readonly isZh: boolean;
  readonly isDone: boolean;
  readonly isRunning: boolean;
  readonly durationMs?: number | null;
  /** 可选展开详情（结果文本）；无结果时不显示展开。 */
  readonly result?: string | null;
};

/**
 * Skill 专用展示：运行时「正在使用 Skill」+ 技能名胶囊。
 * 刻意与通用 tool-call-card / read_file 行区分，避免用户把 Skill 当成普通工具。
 */
export function SkillCapsuleCard({
  skill,
  isZh,
  isDone,
  isRunning,
  durationMs,
  result,
}: SkillCapsuleCardProps) {
  const [expanded, setExpanded] = useState(false);
  const usingLabel = isZh ? '正在使用 Skill' : 'Using Skill';
  const usedLabel = isZh ? '已使用 Skill' : 'Used Skill';
  const statusLabel = isRunning ? usingLabel : usedLabel;
  const canExpand = Boolean(result && result.trim());
  const stateClass = isRunning ? 'running' : isDone ? 'done' : 'idle';

  return (
    <div
      className={`skill-capsule-card ${stateClass}${expanded ? ' expanded' : ''}`}
      onClick={canExpand ? () => setExpanded((value) => !value) : undefined}
      role={canExpand ? 'button' : undefined}
      tabIndex={canExpand ? 0 : undefined}
      onKeyDown={canExpand ? (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          setExpanded((value) => !value);
        }
      } : undefined}
    >
      <div className="skill-capsule-header">
        <span className="skill-capsule-icon" aria-hidden="true">
          {isRunning ? (
            <svg className="skill-capsule-spinner-svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
              <path d="M12 3a9 9 0 1 0 9 9" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2z" />
            </svg>
          )}
        </span>
        <span className="skill-capsule-status">{statusLabel}</span>
        <span className="skill-capsule-pill" title={skill.capabilityId}>
          <span className="skill-capsule-pill-label">Skill</span>
          <span className="skill-capsule-pill-name">{skill.skillName}</span>
        </span>
        {isDone && typeof durationMs === 'number' && Number.isFinite(durationMs) ? (
          <span className="skill-capsule-duration">{formatDuration(durationMs)}</span>
        ) : null}
        {canExpand ? (
          <svg
            className="skill-capsule-expand"
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={expanded ? undefined : { transform: 'rotate(-90deg)' }}
            aria-hidden="true"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        ) : null}
      </div>
      {expanded && result ? (
        <pre className="skill-capsule-output">{result}</pre>
      ) : null}
    </div>
  );
}

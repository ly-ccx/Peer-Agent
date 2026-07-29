import type { SkillDetail, SkillSummary } from '@peer-agent/protocol';
import { useEffect, useState } from 'react';
import { Overlay } from '../../app/components/Overlay';
import { MarkdownMessage } from '../../chat/components/markdown/MarkdownMessage';
import { clientApi } from '../../clientApi';

function ScopeBadge({ scope }: { readonly scope: SkillSummary['scope'] }) {
  return (
    <span className={`skill-scope-badge skill-scope-badge--${scope}`}>
      {scope === 'workspace' ? '工作空间' : '全局'}
    </span>
  );
}

export function SkillDetailDialog({
  skill,
  onClose,
  onToggle,
}: {
  readonly skill: SkillSummary;
  readonly onClose: () => void;
  readonly onToggle: (skillId: string, enabled: boolean) => Promise<void>;
}) {
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void clientApi.getSkillDetail(skill.skillId)
      .then((value) => {
        if (cancelled) return;
        setDetail(value);
        if (!value) setError('无法读取 Skill 内容');
      })
      .catch(() => {
        if (!cancelled) setError('读取 Skill 内容失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [skill.skillId]);

  const current = detail ?? skill;

  return (
    <Overlay
      onClose={onClose}
      ariaLabel={current.name}
      panelClassName="skill-detail-dialog"
    >
      {({ requestClose }) => (
        <>
          <header className="skill-detail-header">
            <span className="skill-avatar skill-detail-avatar" aria-hidden="true">
              {(current.name || '?').charAt(0).toUpperCase()}
            </span>
            <div className="skill-detail-heading">
              <div className="skill-detail-title-row">
                <h2 id="skill-detail-title">{current.name}</h2>
                <ScopeBadge scope={current.scope} />
              </div>
              <p>{current.description || '暂无描述'}</p>
            </div>
            <label className="skill-detail-toggle" onClick={(event) => event.stopPropagation()}>
              <input
                type="checkbox"
                checked={current.enabled}
                disabled={toggling}
                onChange={async (event) => {
                  const enabled = event.target.checked;
                  setToggling(true);
                  try {
                    await onToggle(current.skillId, enabled);
                    setDetail((previous) => previous ? { ...previous, enabled } : previous);
                  } finally {
                    setToggling(false);
                  }
                }}
              />
              <span aria-hidden="true" />
              <span className="sr-only">挂载到当前工作空间</span>
            </label>
            <button type="button" className="skill-detail-close" aria-label="关闭" onClick={requestClose}>×</button>
          </header>

          <div className="skill-detail-meta">
            <span>{current.scope === 'workspace' ? '仅当前工作空间可用' : '所有工作空间均可挂载'}</span>
            {detail?.sourcePath ? <code>{detail.sourcePath}</code> : null}
          </div>

          <div className="skill-detail-content">
            {loading ? <div className="skill-loading">加载内容中…</div> : null}
            {error ? <div className="skill-link-error" role="alert">{error}</div> : null}
            {detail?.whenToUse ? (
              <section className="skill-detail-when">
                <h3>何时使用</h3>
                <p>{detail.whenToUse}</p>
              </section>
            ) : null}
            {detail?.instructions ? <MarkdownMessage content={detail.instructions} /> : null}
          </div>
        </>
      )}
    </Overlay>
  );
}

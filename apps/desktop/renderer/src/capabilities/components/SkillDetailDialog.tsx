import type { SkillDetail, SkillSummary } from '@peer-agent/protocol';
import { useEffect, useState } from 'react';
import { Overlay } from '../../app/components/Overlay';
import { MarkdownMessage } from '../../chat/components/markdown/MarkdownMessage';
import { clientApi } from '../../clientApi';
import { Switch } from '../../ui/boolean-controls';

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
  onUninstall,
}: {
  readonly skill: SkillSummary;
  readonly onClose: () => void;
  readonly onToggle: (skillId: string, enabled: boolean) => Promise<void>;
  readonly onUninstall?: (skillId: string) => Promise<void>;
}) {
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState(false);
  const [confirmUninstall, setConfirmUninstall] = useState(false);
  const [uninstalling, setUninstalling] = useState(false);
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
  const canUninstall = current.scope !== 'workspace' && typeof onUninstall === 'function';

  /** 卸载成功后走 Overlay requestClose，保留统一退场动画；不要直接 onClose 硬卸载。 */
  const handleUninstall = async (requestClose: () => void) => {
    if (!onUninstall || uninstalling) return;
    setUninstalling(true);
    setError(null);
    try {
      await onUninstall(current.skillId);
      requestClose();
    } catch (err) {
      setConfirmUninstall(false);
      setError(err instanceof Error ? err.message : '卸载失败');
    } finally {
      setUninstalling(false);
    }
  };

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
            <Switch
              checked={current.enabled}
              disabled={toggling || uninstalling}
              aria-label="挂载到当前工作空间"
              onClick={(event) => event.stopPropagation()}
              onCheckedChange={async (enabled) => {
                setToggling(true);
                try {
                  await onToggle(current.skillId, enabled);
                  setDetail((previous) => previous ? { ...previous, enabled } : previous);
                } finally {
                  setToggling(false);
                }
              }}
            />
            <button type="button" className="skill-detail-close" aria-label="关闭" onClick={requestClose}><svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg></button>
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

          {canUninstall ? (
            <footer className="skill-detail-footer">
              {confirmUninstall ? (
                <div className="skill-uninstall-confirm" role="group" aria-label="确认卸载">
                  <p>确认卸载「{current.name}」？用户安装目录会被删除；若是借用技能，仅取消本地软链。</p>
                  <div className="skill-uninstall-actions">
                    <button
                      type="button"
                      className="skill-uninstall-cancel"
                      disabled={uninstalling}
                      onClick={() => setConfirmUninstall(false)}
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      className="skill-uninstall-confirm-btn"
                      disabled={uninstalling}
                      onClick={() => { void handleUninstall(requestClose); }}
                    >
                      {uninstalling ? '卸载中…' : '确认卸载'}
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  className="skill-uninstall-btn"
                  disabled={uninstalling}
                  onClick={() => setConfirmUninstall(true)}
                >
                  卸载
                </button>
              )}
            </footer>
          ) : null}
        </>
      )}
    </Overlay>
  );
}

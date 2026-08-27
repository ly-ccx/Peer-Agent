import { useMemo, useState } from 'react';

import { clientApi } from '../../clientApi';

export type HandoffConflictChoice = 'keep_taskline' | 'keep_worktree' | 'keep_both';

export interface HandoffConflictItem {
  readonly path: string;
}

interface Props {
  /** 目标分支名（如 0.0.9），仅用于展示。 */
  readonly planId: string;
  readonly targetBranch?: string;
  readonly conflicts: readonly HandoffConflictItem[];
  /** 决断执行成功后回调（用于刷新概览）。 */
  readonly onResolved?: () => void;
}

const CHOICE_LABEL: Record<HandoffConflictChoice, string> = {
  keep_worktree: '保留工作区',
  keep_taskline: '保留任务线',
  keep_both: '两个都要',
};

const CHOICE_HINT: Record<HandoffConflictChoice, string> = {
  keep_worktree: '工作区这份留下，任务线内容不进',
  keep_taskline: '任务线版合进，工作区旧版存为 .worktree-backup',
  keep_both: '任务线版另存为 .taskline，两份都留',
};

/**
 * ADR 69 P2：合回收口面板。把真冲突（CONFLICT）从逐条红卡聚合为一次收口决断：
 * 每条冲突三选，「预览合并后的目标线」起临时 worktree 真机渲染，「一键应用」批量执行。
 * keep_taskline 动 git 目标线，应用前弹确认（permissionConfirmed）。
 */
export function HandoffConflictPanel({ planId, targetBranch, conflicts, onResolved }: Props) {
  const [choices, setChoices] = useState<Record<string, HandoffConflictChoice>>(() =>
    Object.fromEntries(conflicts.map((c) => [c.path, 'keep_taskline' as HandoffConflictChoice])),
  );
  const [preview, setPreview] = useState<{ previewPath: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dest = targetBranch?.trim() || '源头';
  const needsGrant = useMemo(
    () => Object.values(choices).some((c) => c === 'keep_taskline'),
    [choices],
  );

  const resolutions = useMemo(
    () => conflicts.map((c) => ({ path: c.path, choice: choices[c.path] ?? 'keep_taskline' })),
    [conflicts, choices],
  );

  async function handlePreview() {
    setBusy(true);
    setError(null);
    try {
      const res = await clientApi.goalPlansPreviewHandoffMerge({ planId, resolutions });
      if (res?.ok && res.previewPath) setPreview({ previewPath: res.previewPath });
      else setError(res?.reason ?? '预览失败');
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  }

  async function closePreview() {
    if (preview) {
      try { await clientApi.goalPlansCleanupHandoffPreview({ planId, previewPath: preview.previewPath }); } catch { /* 尽力清理 */ }
    }
    setPreview(null);
  }

  async function handleApply() {
    setBusy(true);
    setError(null);
    try {
      let permissionConfirmed = false;
      if (needsGrant) {
        // 高影响：keep_taskline 会动 git 目标线。先弹确认。
        // eslint-disable-next-line no-alert
        permissionConfirmed = window.confirm(
          `「保留任务线」会把任务线版本合并进 ${dest}，并覆盖工作区同名文件（旧版存为 .worktree-backup，不丢）。\n\n确定继续吗？`,
        );
        if (!permissionConfirmed) { setBusy(false); return; }
      }
      const res = await clientApi.goalPlansResolveHandoffConflicts({ planId, resolutions, permissionConfirmed });
      if (res?.ok) {
        await closePreview();
        onResolved?.();
      } else if (res?.reason === 'permission_required') {
        setError('需要确认后才能合并');
      } else {
        setError(res?.reason ?? '应用失败');
      }
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="handoff-conflict-panel" data-testid="handoff-conflict-panel">
      <div className="handoff-conflict-panel__head">
        合不进 {dest} · {conflicts.length} 处真冲突
      </div>
      <ul className="handoff-conflict-panel__list">
        {conflicts.map((c) => (
          <li key={c.path} className="handoff-conflict-panel__row">
            <div className="handoff-conflict-panel__path" title={c.path}>{c.path}</div>
            <div className="handoff-conflict-panel__choices" role="radiogroup" aria-label={`${c.path} 取舍`}>
              {(Object.keys(CHOICE_LABEL) as HandoffConflictChoice[]).map((choice) => (
                <label key={choice} className="handoff-conflict-panel__choice" title={CHOICE_HINT[choice]}>
                  <input
                    type="radio"
                    name={`hc-${c.path}`}
                    checked={choices[c.path] === choice}
                    onChange={() => setChoices((prev) => ({ ...prev, [c.path]: choice }))}
                  />
                  <span>{CHOICE_LABEL[choice]}</span>
                </label>
              ))}
            </div>
          </li>
        ))}
      </ul>
      {preview ? (
        <div className="handoff-conflict-panel__preview">
          预览副本：{preview.previewPath}
          <button type="button" onClick={closePreview} disabled={busy}>关闭预览</button>
        </div>
      ) : null}
      {error ? <div className="handoff-conflict-panel__error">{error}</div> : null}
      <div className="handoff-conflict-panel__actions">
        <button type="button" onClick={handlePreview} disabled={busy}>
          预览合并后的 {dest}
        </button>
        <button type="button" className="handoff-conflict-panel__apply" onClick={handleApply} disabled={busy}>
          {busy ? '应用中…' : '一键应用'}
        </button>
      </div>
    </div>
  );
}

export default HandoffConflictPanel;

import { useEffect, useState } from 'react';
import type { TaskOverviewItem } from '@peer-agent/protocol';
import { clientApi } from '../../clientApi';

function isSourceEnvBlock(item: TaskOverviewItem): boolean {
  return Boolean(
    item.deliveryHandoffStoppedReason
    && item.deliveryTargetBranch
    && item.blockedPlanIds?.length
    && item.deliveryHandoffVerdict !== 'CONFLICT',
  );
}

export { isSourceEnvBlock };

function inspectHint(reason: string | undefined): string {
  if (reason === 'missing_workspace') return '找不到源头工作区，没法列出挡路文件。';
  return '没法列出挡路文件。提交、放下或再试一次仍然可以继续。';
}

function sourceActionHint(
  action: 'commit' | 'stash' | 'retry',
  result: { reason?: string; detail?: string } | null | undefined,
): string {
  const detail = result?.detail?.trim();
  if (result?.reason === 'permission_required') {
    return action === 'stash' ? '需要你确认后再放下。' : '需要你确认后再提交。';
  }
  if (result?.reason === 'nothing_to_commit') return '源头没有已跟踪的未提交改动，可以直接再试一次。';
  if (detail) return detail;
  if (action === 'commit') return '提交没成功。';
  if (action === 'stash') return '放下没成功。';
  return '再合失败。';
}

export function SourceCheckoutPanel({ item }: { readonly item: TaskOverviewItem }) {
  const [files, setFiles] = useState<ReadonlyArray<{ path: string; status: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const dest = item.deliveryTargetBranch || '源头';
  const planIds = item.blockedPlanIds || [];
  const workspacePath = item.deliveryWorkspacePath?.trim() || undefined;
  const inspectPlanId = planIds[0];
  const canAct = Boolean(workspacePath || inspectPlanId);
  const canRetry = planIds.length > 0;

  useEffect(() => {
    if (!canAct) {
      setLoaded(true);
      setError('找不到源头工作区，没法列出挡路文件。');
      return;
    }
    let cancelled = false;
    void clientApi.goalPlansInspectSourceCheckout({
      ...(inspectPlanId ? { planId: inspectPlanId } : {}),
      ...(workspacePath ? { workspacePath } : {}),
    }).then((res) => {
      if (cancelled) return;
      setLoaded(true);
      if (res?.ok && Array.isArray(res.files)) {
        setFiles(res.files);
        setError(null);
      } else {
        setFiles([]);
        setError(inspectHint(res?.reason));
      }
    }).catch((err) => {
      if (cancelled) return;
      setLoaded(true);
      setFiles([]);
      setError(inspectHint(err instanceof Error ? err.message : undefined));
    });
    return () => { cancelled = true; };
  }, [canAct, inspectPlanId, workspacePath]);

  async function afterSourceReady(action: 'commit' | 'stash' | 'retry') {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const sourceParams = {
        ...(inspectPlanId ? { planId: inspectPlanId } : {}),
        ...(workspacePath ? { workspacePath } : {}),
        permissionConfirmed: true,
      };
      if (action === 'commit') {
        const confirmed = window.confirm(`把 ${dest} 上挡路的已跟踪改动提交掉，再把 ${planIds.length} 条任务一起合进去？`);
        if (!confirmed) { setBusy(false); return; }
        const committed = await clientApi.goalPlansCommitSourceCheckout(sourceParams);
        if (!committed?.ok) {
          setError(sourceActionHint('commit', {
            reason: committed?.reason,
            detail: committed?.detail,
          }));
          return;
        }
      } else if (action === 'stash') {
        const confirmed = window.confirm(`先把 ${dest} 上挡路的已跟踪改动放下，再把 ${planIds.length} 条任务一起合进去？`);
        if (!confirmed) { setBusy(false); return; }
        const stashed = await clientApi.goalPlansStashSourceCheckout(sourceParams);
        if (!stashed?.ok) {
          setError(sourceActionHint('stash', stashed));
          return;
        }
      }
      const retried = await clientApi.goalPlansRetrySourceHandoffs({ planIds });
      if (!retried?.ok) {
        setError(sourceActionHint('retry', retried));
        return;
      }
      const stillBlocked = (retried.results || []).filter((result) => !result.ok).length;
      if (stillBlocked > 0) setError(`还有 ${stillBlocked} 条没合进去。`);
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="source-checkout-panel" data-testid="source-checkout-panel">
      <div className="source-checkout-panel__head">
        {dest} 上还有未提交的改动，{planIds.length} 条任务等着合进去。
      </div>
      {files.length > 0 ? (
        <ul className="source-checkout-panel__files">
          {files.map((file) => (
            <li key={file.path} className="gwb-chip">{file.path}</li>
          ))}
        </ul>
      ) : (
        <div className="source-checkout-panel__empty">
          {loaded ? (error || '源头上没有已跟踪的未提交改动。可以直接再试一次。') : '正在看挡路文件…'}
        </div>
      )}
      {error && files.length > 0 ? <div className="source-checkout-panel__note">{error}</div> : null}
      <div className="source-checkout-panel__actions">
        <button
          type="button"
          className="gwb-btn gwb-btn-ghost"
          disabled={busy || !canAct}
          onClick={() => void afterSourceReady('commit')}
        >
          提交这些改动
        </button>
        <button
          type="button"
          className="gwb-btn gwb-btn-ghost"
          disabled={busy || !canAct}
          onClick={() => void afterSourceReady('stash')}
        >
          先放下再合
        </button>
        <button
          type="button"
          className="gwb-btn gwb-btn-primary"
          disabled={busy || !canRetry}
          onClick={() => void afterSourceReady('retry')}
        >
          {busy ? '处理中…' : `再试一次，${planIds.length} 条一起合进 ${dest}`}
        </button>
      </div>
    </div>
  );
}

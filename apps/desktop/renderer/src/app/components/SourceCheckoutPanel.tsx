import { useEffect, useState } from 'react';
import type { TaskOverviewItem } from '@peer-agent/protocol';
import { clientApi } from '../../clientApi';
import { useConfirm } from './ConfirmProvider';

function isSourceEnvBlock(item: TaskOverviewItem): boolean {
  return Boolean(
    item.deliveryHandoffStoppedReason
    && item.deliveryTargetBranch
    && item.blockedPlanIds?.length
    && item.deliveryHandoffVerdict !== 'CONFLICT'
    && item.deliveryHandoffStoppedReason !== 'merge_conflict'
    && item.deliveryHandoffStoppedReason !== 'merge_conflict_untracked',
  );
}

function isWorkbenchHandoffCard(item: TaskOverviewItem): boolean {
  return isSourceEnvBlock(item)
    || Boolean(
      item.deliveryHandoffStoppedReason
      && item.deliveryTargetBranch
      && (item.deliveryHandoffVerdict === 'CONFLICT'
        || item.deliveryHandoffStoppedReason === 'merge_conflict'
        || item.deliveryHandoffStoppedReason === 'merge_conflict_untracked'),
    );
}

export { isSourceEnvBlock, isWorkbenchHandoffCard };

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
  const confirm = useConfirm();
  const [files, setFiles] = useState<ReadonlyArray<{ path: string; status: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const dest = item.deliveryTargetBranch || '源头';
  const planIds = item.blockedPlanIds?.length
    ? item.blockedPlanIds
    : (item.taskId && !item.taskId.startsWith('source-block:') ? [item.taskId] : []);
  const workspacePath = item.deliveryWorkspacePath?.trim() || undefined;
  const inspectPlanId = planIds[0];
  const canAct = Boolean(workspacePath || inspectPlanId);
  const canRetry = planIds.length > 0;
  const conflictFiles = item.deliveryHandoffConflicts?.map((conflict) => conflict.path).filter(Boolean) ?? [];
  const isConflict = item.deliveryHandoffVerdict === 'CONFLICT'
    || item.deliveryHandoffStoppedReason === 'merge_conflict'
    || item.deliveryHandoffStoppedReason === 'merge_conflict_untracked';

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
        const ok = await confirm({
          title: `提交 ${dest} 上的挡路改动`,
          message: `把已跟踪改动提交掉，再把 ${planIds.length} 件事一起合进 ${dest}。`,
          confirmText: '提交并合进',
        });
        if (!ok) { setBusy(false); return; }
        const committed = await clientApi.goalPlansCommitSourceCheckout(sourceParams);
        if (!committed?.ok) {
          setError(sourceActionHint('commit', {
            reason: committed?.reason,
            detail: committed?.detail,
          }));
          return;
        }
      } else if (action === 'stash') {
        const ok = await confirm({
          title: `先放下 ${dest} 上的挡路改动`,
          message: `把未提交改动先放下，再把 ${planIds.length} 件事一起合进 ${dest}。`,
          confirmText: '放下再合',
        });
        if (!ok) { setBusy(false); return; }
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

  async function declineMerge() {
    if (busy || planIds.length === 0) return;
    const ok = await confirm({
      title: `这 ${planIds.length} 件不合进 ${dest}`,
      message: `任务线会拆掉，改动不会合进 ${dest}。本地草稿仍留在当前工作区。`,
      confirmText: '不合进',
      tone: 'danger',
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      const declined = await clientApi.goalPlansDeclineSourceHandoffs({ planIds });
      const stillWaiting = (declined.results || []).filter((result) => !result.ok).length;
      if (stillWaiting > 0) setError(`还有 ${stillWaiting} 条没拿掉。`);
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="source-checkout-panel" data-testid="source-checkout-panel">
      <div className="source-checkout-panel__head">
        {isConflict
          ? `这 ${planIds.length} 件和 ${dest} 上的同一份文件内容不同，合不进去。`
          : `${dest} 上还有未提交的改动，这 ${planIds.length} 件事等着合进去。`}
      </div>
      {item.blockedPlanTitles?.length ? (
        <ul className="source-checkout-panel__files" aria-label="等合进的任务">
          {item.blockedPlanTitles.map((title) => (
            <li key={title} className="gwb-chip">{title}</li>
          ))}
        </ul>
      ) : item.title ? (
        <ul className="source-checkout-panel__files" aria-label="等合进的任务">
          <li className="gwb-chip">{item.title}</li>
        </ul>
      ) : null}
      {isConflict && conflictFiles.length > 0 ? (
        <ul className="source-checkout-panel__files">
          {conflictFiles.map((filePath) => (
            <li key={filePath} className="gwb-chip">{filePath}</li>
          ))}
        </ul>
      ) : null}
      {files.length > 0 ? (
        <ul className="source-checkout-panel__files">
          {files.map((file) => (
            <li key={file.path} className="gwb-chip">{file.path}</li>
          ))}
        </ul>
      ) : (
        <div className="source-checkout-panel__empty">
          {loaded
            ? (error || (isConflict
              ? (conflictFiles.length > 0 ? null : `这几件和 ${dest} 上的同一份文件内容不同。`)
              : '源头上没有已跟踪的未提交改动。可以直接再试一次。'))
            : '正在看挡路文件…'}
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
          className="gwb-btn"
          disabled={busy || !canRetry}
          onClick={() => void declineMerge()}
        >
          {`这 ${planIds.length} 件不合进 ${dest}`}
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

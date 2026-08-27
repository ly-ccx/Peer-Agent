import { useEffect, useRef, useState } from 'react';
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
  if (reason === 'unavailable') return '这台桌面还没接上源头检查。';
  if (reason === 'not_found') return '找不到对应的任务，没法看源头。';
  return '源头检查没成功。';
}

function sourceActionHint(reason: string | undefined, detail?: string): string | null {
  if (detail?.trim()) return detail.trim();
  if (reason === 'permission_required') return '需要确认后才能改源头。';
  if (reason === 'commit_failed') return '提交没成功。';
  if (reason === 'stash_failed') return '放下没成功。';
  if (reason === 'nothing_to_commit') return null;
  return reason ? inspectHint(reason) : null;
}

export function SourceCheckoutPanel({ item }: { readonly item: TaskOverviewItem }) {
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const [files, setFiles] = useState<Array<{ path: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const autoTried = useRef(false);
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
  const sourceParams = {
    ...(inspectPlanId ? { planId: inspectPlanId } : {}),
    ...(workspacePath ? { workspacePath } : {}),
    permissionConfirmed: true,
  };

  useEffect(() => {
    if (isConflict) {
      setLoaded(true);
      setFiles([]);
      setError(null);
      return;
    }
    if (!canAct) {
      setLoaded(true);
      setFiles([]);
      setError('找不到源头工作区，没法列出挡路文件。');
      return;
    }
    let cancelled = false;
    setLoaded(false);
    clientApi.goalPlansInspectSourceCheckout({
      ...(inspectPlanId ? { planId: inspectPlanId } : {}),
      ...(workspacePath ? { workspacePath } : {}),
    }).then((result) => {
      if (cancelled) return;
      setLoaded(true);
      if (!result.ok) {
        setFiles([]);
        setError(inspectHint(result.reason));
        return;
      }
      setFiles([...(result.files || [])]);
      setError(null);
    }).catch((err) => {
      if (cancelled) return;
      setLoaded(true);
      setFiles([]);
      setError(inspectHint(err instanceof Error ? err.message : undefined));
    });
    return () => { cancelled = true; };
  }, [canAct, inspectPlanId, isConflict, workspacePath]);

  async function retryMerge() {
    if (!canRetry) return false;
    const retried = await clientApi.goalPlansRetrySourceHandoffs({ planIds });
    const stillBlocked = (retried.results || []).filter((result) => !result.ok).length;
    if (stillBlocked > 0) {
      setError(`还有 ${stillBlocked} 条没合进去。`);
      return false;
    }
    setStatus(`正在合进 ${dest}…`);
    return true;
  }

  async function commitThenRetry() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const committed = await clientApi.goalPlansCommitSourceCheckout({
        ...sourceParams,
        message: `peer: commit source checkout to merge into ${dest}`,
      });
      if (!committed.ok) {
        setError(sourceActionHint(committed.reason, committed.detail) || '提交没成功。');
        return;
      }
      setStatus('已提交源头改动，接着合回。');
      await retryMerge();
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  }

  async function askCommitThenRetry() {
    const ok = await confirm({
      title: `提交源头改动再合进 ${dest}`,
      message: `源头上还有 ${files.length} 个未提交改动。提交后才能把这 ${planIds.length} 件合进去。`,
      confirmText: '提交并合进',
    });
    if (!ok) return;
    await commitThenRetry();
  }

  useEffect(() => {
    if (isConflict || !loaded || busy || autoTried.current) return;
    if (error || files.length > 0) return;
    if (!canRetry) return;
    autoTried.current = true;
    setBusy(true);
    setStatus(`源头干净，正在合进 ${dest}…`);
    void retryMerge().finally(() => setBusy(false));
  }, [busy, canRetry, dest, error, files.length, isConflict, loaded]);

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

  async function mergeConflictIn() {
    if (busy || !inspectPlanId) return;
    const ok = await confirm({
      title: `合进 ${dest}`,
      message: conflictFiles.length
        ? `会用任务线版本覆盖 ${dest} 上这 ${conflictFiles.length} 个文件。`
        : `会再把这 ${planIds.length} 件合进 ${dest}。`,
      confirmText: '合进去',
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      if (conflictFiles.length > 0) {
        const resolved = await clientApi.goalPlansResolveHandoffConflicts({
          planId: inspectPlanId,
          resolutions: conflictFiles.map((path) => ({ path, choice: 'keep_taskline' as const })),
          permissionConfirmed: true,
        });
        if (!resolved.ok) {
          setError(resolved.reason === 'permission_required' ? '需要确认后才能合并。' : (resolved.reason || '合进去没成功。'));
          return;
        }
        setStatus(`已合进 ${dest}。`);
        return;
      }
      await retryMerge();
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  }

  const titles = item.blockedPlanTitles?.length
    ? item.blockedPlanTitles
    : (item.title ? [item.title] : []);

  return (
    <div className="source-checkout-panel" data-testid="source-checkout-panel">
      <div className="source-checkout-panel__head">
        {isConflict
          ? `这 ${planIds.length} 件和 ${dest} 上的同一份文件内容不同，合不进去。`
          : files.length > 0
            ? `${dest} 上还有未提交的改动，提交后才能合进去。`
            : (status || `${dest} 上没有已跟踪的未提交改动。`)}
      </div>
      {titles.length > 1 ? (
        <ul className="source-checkout-panel__files" aria-label="等合进的任务">
          {titles.map((title) => (
            <li key={title} className="gwb-chip">{title}</li>
          ))}
        </ul>
      ) : null}
      {isConflict && conflictFiles.length > 0 ? (
        <ul className="source-checkout-panel__files">
          {conflictFiles.map((filePath) => (
            <li key={filePath} className="gwb-chip">{filePath}</li>
          ))}
        </ul>
      ) : null}
      {!isConflict && files.length > 0 ? (
        <ul className="source-checkout-panel__files">
          {files.map((file) => (
            <li key={file.path} className="gwb-chip">{file.path}</li>
          ))}
        </ul>
      ) : null}
      {error ? <div className="source-checkout-panel__note">{error}</div> : null}
      {!loaded && !isConflict ? (
        <div className="source-checkout-panel__empty">正在看挡路文件…</div>
      ) : null}
      <div className="source-checkout-panel__actions">
        {isConflict ? (
          <>
            <button
              type="button"
              className="gwb-btn"
              disabled={busy || !canRetry}
              onClick={() => void declineMerge()}
            >
              {`不合进 ${dest}`}
            </button>
            <button
              type="button"
              className="gwb-btn gwb-btn-primary"
              disabled={busy || !canRetry}
              onClick={() => void mergeConflictIn()}
            >
              {busy ? '处理中…' : `合进 ${dest}`}
            </button>
          </>
        ) : files.length > 0 ? (
          <button
            type="button"
            className="gwb-btn gwb-btn-primary"
            disabled={busy || !canAct}
            onClick={() => void askCommitThenRetry()}
          >
            {busy ? '处理中…' : `提交并合进 ${dest}`}
          </button>
        ) : error ? (
          <button
            type="button"
            className="gwb-btn gwb-btn-primary"
            disabled={busy || !canRetry}
            onClick={() => {
              autoTried.current = true;
              setBusy(true);
              void retryMerge().finally(() => setBusy(false));
            }}
          >
            {busy ? '处理中…' : `再试合进 ${dest}`}
          </button>
        ) : null}
      </div>
    </div>
  );
}

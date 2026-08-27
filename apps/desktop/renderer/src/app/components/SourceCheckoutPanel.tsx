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

export function SourceCheckoutPanel({ item }: { readonly item: TaskOverviewItem }) {
  const [files, setFiles] = useState<ReadonlyArray<{ path: string; status: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dest = item.deliveryTargetBranch || '源头';
  const planIds = item.blockedPlanIds || [];
  const inspectPlanId = planIds[0];

  useEffect(() => {
    if (!inspectPlanId) return;
    let cancelled = false;
    void clientApi.goalPlansInspectSourceCheckout({ planId: inspectPlanId }).then((res) => {
      if (cancelled) return;
      if (res?.ok && Array.isArray(res.files)) setFiles(res.files);
      else setError(res?.reason ?? '没法列出挡路文件');
    }).catch((err) => {
      if (!cancelled) setError(String(err instanceof Error ? err.message : err));
    });
    return () => { cancelled = true; };
  }, [inspectPlanId]);

  async function afterSourceReady(action: 'commit' | 'stash' | 'retry') {
    setBusy(true);
    setError(null);
    try {
      if (action === 'commit') {
        const confirmed = window.confirm(`把 ${dest} 上挡路的已跟踪改动提交掉，再把 ${planIds.length} 条任务一起合进去？`);
        if (!confirmed) { setBusy(false); return; }
        const committed = await clientApi.goalPlansCommitSourceCheckout({
          planId: inspectPlanId,
          permissionConfirmed: true,
        });
        if (!committed?.ok) {
          setError(committed?.reason ?? '提交失败');
          return;
        }
      } else if (action === 'stash') {
        const confirmed = window.confirm(`先把 ${dest} 上未提交的改动放下，再把 ${planIds.length} 条任务一起合进去？`);
        if (!confirmed) { setBusy(false); return; }
        const stashed = await clientApi.goalPlansStashSourceCheckout({
          planId: inspectPlanId,
          permissionConfirmed: true,
        });
        if (!stashed?.ok) {
          setError(stashed?.reason ?? '放下失败');
          return;
        }
      }
      const retried = await clientApi.goalPlansRetrySourceHandoffs({ planIds });
      if (!retried?.ok) {
        setError(retried?.reason ?? '再合失败');
        return;
      }
      const stillBlocked = (retried.results || []).filter((result) => !result.ok).length;
      if (stillBlocked > 0) setError(`还有 ${stillBlocked} 条没合进去`);
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="source-checkout-panel" data-testid="source-checkout-panel">
      <div className="source-checkout-panel__head">
        {dest} 上还有未提交的改动，挡住了 {planIds.length} 条任务。
      </div>
      {files.length > 0 ? (
        <ul className="source-checkout-panel__files">
          {files.map((file) => (
            <li key={file.path}>{file.path}</li>
          ))}
        </ul>
      ) : (
        <div className="source-checkout-panel__empty">正在看挡路文件…</div>
      )}
      {item.blockedPlanTitles?.length ? (
        <details className="source-checkout-panel__tasks">
          <summary>都有哪些任务</summary>
          <ul>
            {item.blockedPlanTitles.map((title) => (
              <li key={title}>{title}</li>
            ))}
          </ul>
        </details>
      ) : null}
      {error ? <div className="source-checkout-panel__error">{error}</div> : null}
      <div className="source-checkout-panel__actions">
        <button type="button" disabled={busy || !inspectPlanId} onClick={() => void afterSourceReady('commit')}>
          提交这些改动
        </button>
        <button type="button" disabled={busy || !inspectPlanId} onClick={() => void afterSourceReady('stash')}>
          先放下再合
        </button>
        <button
          type="button"
          className="source-checkout-panel__apply"
          disabled={busy || planIds.length === 0}
          onClick={() => void afterSourceReady('retry')}
        >
          {busy ? '处理中…' : `再试一次，${planIds.length} 条一起合进 ${dest}`}
        </button>
      </div>
    </div>
  );
}

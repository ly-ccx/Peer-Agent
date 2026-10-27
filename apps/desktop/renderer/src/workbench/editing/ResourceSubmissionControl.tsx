import { PeerIcon } from '../../ui/icons';
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { MotionDetails } from '../../app/components/MotionDetails';
import { resourceEditRegistry } from './resourceEditRegistry';
import type { ResourceEditSession } from './resourceEditSession';
import type { ResourceSubmissionController } from './resourceSubmissionController';
import { resourceSubmissionIssue, resourceSubmissionLabel } from './resourceSubmissionMessages';
import { ResourceSubmissionDetails } from './ResourceSubmissionDetails';
export function ResourceSubmissionControl({ session, active, isZh, onCompare }: { readonly session: ResourceEditSession; readonly active: boolean; readonly isZh: boolean; readonly onCompare: () => void }) {
  const controller = useMemo(() => resourceEditRegistry()?.submissionFor(session) ?? null, [session]);
  return controller ? <SubmissionControl controller={controller} session={session} active={active} isZh={isZh} onCompare={onCompare} />
    : <footer className="resource-submission"><span className="resource-source-label">{isZh ? '提交原文件暂不可用，正常重启应用后可重试。' : 'File submission is unavailable. Restart the app normally to retry.'}</span></footer>;
}
function SubmissionControl({ controller, session, active, isZh, onCompare }: { readonly controller: ResourceSubmissionController; readonly session: ResourceEditSession; readonly active: boolean; readonly isZh: boolean; readonly onCompare: () => void }) {
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot), draft = useSyncExternalStore(session.subscribe, session.snapshot, session.snapshot);
  const [open, setOpen] = useState(false), owner = useRef({}), scopeId = useId(), handleKey = JSON.stringify(draft.view?.handle);
  useEffect(() => { controller.activate(active, owner.current); return () => controller.activate(false, owner.current); }, [controller, active, handleKey]);
  useEffect(() => { if (open && active && state.selectedId) void controller.loadDetails(); }, [controller, open, active, state.selectedId, state.status?.hasActualResult, state.status?.governance]);
  const status = state.status, op = status?.operation, permission = status?.permission, blocked = controller.readiness(), busy = !!state.action;
  const choose = (zh: string, en: string) => isZh ? zh : en;
  const reason = state.execution?.record.result.observation?.reason ?? state.execution?.record.result.blockedReason;
  const showReason = reason && reason !== 'no_change' && op?.receipt?.outcome !== 'applied';
  return <footer className="resource-submission" aria-label={choose('提交原文件', 'Submit to original file')}>
    <div className="resource-submission-summary"><span role="status" aria-live="polite" aria-atomic="true">{resourceSubmissionLabel(state, isZh)}</span>
      <button type="button" className="ui-button is-compact" disabled={state.refreshing || !draft.view} onClick={() => void controller.refresh()}>{choose('刷新状态', 'Refresh status')}</button></div>
    {permission ? <div className="resource-submission-scope" id={scopeId}><span>{choose('仅将本次固定稿写入：', 'Write only this fixed submission to: ')}</span><code>{permission.path}</code>
      {permission.confirmation ? <span>{choose('额外检查要求本次确认：', 'An additional check requires this decision: ')}{permission.confirmation}</span> : null}</div> : null}
    <div className="resource-submission-actions">
      {permission ? <><button type="button" className="ui-button is-primary" aria-describedby={scopeId} disabled={busy || draft.composing} onClick={() => void controller.decide(true)}>{choose('允许本次写入', 'Allow this write')}</button>
        <button type="button" className="ui-button" aria-describedby={scopeId} disabled={busy || draft.composing} onClick={() => void controller.decide(false)}>{choose('拒绝', 'Deny')}</button>
        <button type="button" className="ui-button" disabled={busy && state.action !== 'permission'} onClick={() => void controller.cancel()}>{choose('取消本次提交', 'Cancel this submission')}</button></>
        : state.intent ? <><button type="button" className="ui-button" disabled={state.refreshing || !draft.view} onClick={() => void controller.refresh()}>{choose('核对提交是否受理', 'Check submission receipt')}</button>
          {state.missing ? <button type="button" className="ui-button" disabled={draft.composing || busy && state.action !== 'submit'} onClick={() => void controller.reconnectMissing()}>{choose('重新连接并核对', 'Reconnect and reconcile')}</button> : null}</>
          : op?.phase === 'prepared' ? <><button type="button" className="ui-button is-primary" disabled={busy || draft.composing} onClick={() => void controller.continueSubmission()}>{choose('继续这次提交', 'Continue this submission')}</button>
            <button type="button" className="ui-button" disabled={busy} onClick={() => void controller.cancel()}>{choose('撤回提交', 'Withdraw submission')}</button></>
            : op?.phase === 'uncertain' || op?.phase === 'running' && !status?.live ? <button type="button" className="ui-button is-primary" disabled={busy} onClick={() => void controller.reconcile()}>{choose('核对原操作', 'Reconcile original operation')}</button>
              : op?.phase === 'running' ? <><button type="button" className="ui-button" disabled aria-busy="true">{choose('提交处理中…', 'Processing submission…')}</button>
                <button type="button" className="ui-button" disabled={busy} onClick={() => void controller.cancel()}>{choose('请求取消', 'Request cancellation')}</button></>
                : blocked === 'RESOURCE_EDIT_NEW_BASE_REQUIRED' ? <button type="button" className="ui-button is-primary" disabled={draft.composing} onClick={onCompare}>{choose('比较后继续编辑', 'Compare before continuing')}</button>
                  : <button type="button" className="ui-button is-primary" disabled={busy || !!blocked} title={blocked ? resourceSubmissionIssue(blocked, isZh) : undefined} onClick={() => void controller.submit()} aria-busy={state.action === 'submit'}>{choose('提交当前稿到原文件', 'Submit current draft to file')}</button>}
      {op?.phase === 'settled' ? <button type="button" className="ui-button" disabled={busy} onClick={() => void controller.reconcile()}>{choose('核对原操作', 'Reconcile original operation')}</button> : null}
      {(op?.phase === 'uncertain' || op?.receipt?.outcome === 'conflict') ? <button type="button" className="ui-button" disabled={draft.composing} onClick={onCompare}>{choose('比较当前文件', 'Compare current file')}</button> : null}
    </div>
    {state.error ? <p className="resource-submission-error" role="alert">{resourceSubmissionIssue(state.error, isZh)}</p> : null}
    {showReason && !state.error ? <p className="resource-submission-error">{resourceSubmissionIssue(reason!, isZh)}</p> : null}
    {blocked === 'RESOURCE_EDIT_NEW_BASE_REQUIRED' || state.blockers ? <p className="resource-source-label">{resourceSubmissionIssue(blocked ?? 'RESOURCE_EDIT_OPERATION_PENDING', isZh)}</p> : null}
    {state.selectedId ? <MotionDetails open={open} onToggle={event => { if (event.target === event.currentTarget) setOpen(event.currentTarget.open); }}><summary><PeerIcon name="chevronRight" size={12} />{choose('提交稿与实际结果', 'Submitted text and actual result')}</summary>
      <ResourceSubmissionDetails controller={controller} state={state} isZh={isZh} /></MotionDetails> : null}
  </footer>;
}

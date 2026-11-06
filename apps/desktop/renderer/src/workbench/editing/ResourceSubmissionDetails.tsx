import { PeerIcon } from '../../ui/icons';
import { useState } from 'react';
import { MotionDetails } from '../../app/components/MotionDetails';
import { SourceViewer } from '../file-preview/SourceViewer';
import { highlightLanguageForPath } from '../file-preview/fileTypes';
import { resourceEditOutcome } from './resourceEditMessages';
import { resourceSubmissionIssue } from './resourceSubmissionMessages';
import type { ResourceSubmissionController, ResourceSubmissionState } from './resourceSubmissionController';
export function ResourceSubmissionDetails({ controller, state, isZh }: { readonly controller: ResourceSubmissionController; readonly state: ResourceSubmissionState; readonly isZh: boolean }) {
  const [mode, setMode] = useState<'proposal' | 'result'>('proposal');
  const preview = state.preview, record = state.execution?.record, result = record?.result.observation;
  const ops = [...state.operations].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.requestId.localeCompare(b.requestId));
  const choose = (zh: string, en: string) => isZh ? zh : en;
  return <div className="resource-submission-body">
    <label className="resource-submission-record-label">{choose('提交记录', 'Submission record')}
      <select value={state.selectedId ?? ''} disabled={!!state.action || !!state.intent} onChange={event => controller.select(event.target.value)} aria-label={choose('选择原提交记录', 'Select original submission')}>
        {!state.selectedId || !ops.some(op => op.requestId === state.selectedId) ? <option value={state.selectedId ?? ''}>{choose('提交记录待确认', 'Submission record unconfirmed')}</option> : null}
        {ops.map(op => <option key={op.requestId} value={op.requestId}>{new Date(op.createdAt).toLocaleString(isZh ? 'zh-CN' : 'en-US')} · {op.phase === 'settled' ? resourceEditOutcome(op.receipt?.outcome, isZh) : op.phase === 'uncertain' ? choose('待核对', 'Needs reconciliation') : op.phase === 'prepared' ? choose('尚未执行', 'Not executed') : choose('等待回执', 'Awaiting receipt')}</option>)}
      </select>
    </label>
    <div className="resource-editor-toolbar" role="group" aria-label={choose('提交详情内容', 'Submission detail contents')}>
      <button type="button" className="ui-button is-compact" aria-pressed={mode === 'proposal'} onClick={() => setMode('proposal')}>{choose('固定提交稿', 'Fixed submission')}</button>
      <button type="button" className="ui-button is-compact" aria-pressed={mode === 'result'} onClick={() => setMode('result')}>{choose('实际写入结果', 'Actual write result')}</button>
      <button type="button" className="ui-button is-compact" disabled={state.detailsLoading} onClick={() => void controller.loadDetails()}>{choose('重读详情', 'Read details again')}</button>
    </div>
    {state.detailsLoading ? <p className="resource-source-label" role="status">{choose('正在读取原记录…', 'Reading original records…')}</p> : null}
    {mode === 'proposal' ? <>
      <p className="resource-source-label">{choose('这是本次请求固定的基础与提交稿，后来的输入不会替换它。', 'These are this request’s fixed base and proposed text. Later input does not replace them.')}</p>
      {preview ? <div className="resource-editor-comparison">
        <section><h3>{choose('本次原基础', 'Original base for this submission')}</h3><SourceViewer content={preview.baseText} language={highlightLanguageForPath(preview.operation.target.reference.path)} isZh={isZh} emptyLabel={choose('基础为空。', 'Empty base.')} /></section>
        <section><h3>{choose('本次提交稿', 'Submitted text')}</h3><SourceViewer content={preview.text} language={highlightLanguageForPath(preview.operation.target.reference.path)} isZh={isZh} emptyLabel={choose('提交稿为空。', 'Empty submission.')} /></section>
      </div> : !state.detailsLoading ? <p role="status">{state.previewError ? resourceSubmissionIssue(state.previewError, isZh) : choose('尚无可读取的原提交稿。', 'No original submission text is available.')}</p> : null}
    </> : <>
      {record ? <>
        <p>{record.result.evidence.summary}</p>
        {result?.reason || record.result.blockedReason ? <p>{resourceSubmissionIssue(result?.reason ?? record.result.blockedReason!, isZh)}</p> : null}
        {result?.diffPreview !== undefined ? <section><h3>{choose('实际 Provider 差异预览', 'Actual Provider diff preview')}</h3>
          {result.diffPreviewTruncated ? <p className="resource-source-label">{choose('此预览已截断；不代表完整差异或可执行补丁。', 'This preview is truncated. It is not a complete diff or executable patch.')}</p> : null}
          <SourceViewer content={result.diffPreview} language="diff" isZh={isZh} emptyLabel={choose('实际没有文本差异。', 'No actual text difference.')} /></section> : null}
        <p className="resource-source-label">{state.status?.operation.target.reference.task ? choose('写入读回不等于独立验证或签收；请以原任务的验证、签收记录为准。', 'Write readback is separate from independent verification and acceptance. Those facts remain in the original task.')
          : choose('本次手动文件提交不产生任务验证或签收结论。', 'This manual file submission does not create task verification or acceptance.')}</p>
        {state.execution?.postlude?.status === 'unconfirmed' || state.status?.governance === 'pending' ? <p>{choose('后置检查尚未确认；原文件实际写入结果保留，不会重跑。', 'The post-check is unconfirmed. The actual file result is preserved without replay.')}</p> : null}
        <MotionDetails><summary><PeerIcon name="chevronRight" size={12} />{choose('原始调用与依据', 'Original call and evidence')}</summary><pre className="resource-submission-facts">{JSON.stringify({ call: record.call, grant: record.grant, result: record.result, postlude: state.execution?.postlude }, null, 2)}</pre></MotionDetails>
      </> : <p>{state.executionError ? resourceSubmissionIssue(state.executionError, isZh) : choose('尚无可读取的实际执行结果，不会以草稿或当前文件代替依据。', 'No actual execution result is available. Neither the draft nor current file substitutes for evidence.')}</p>}
    </>}
  </div>;
}

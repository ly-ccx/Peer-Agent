import { useEffect, useRef, useState } from 'react';
import type { ManagedShellTask } from '@peer-agent/protocol';
import { backgroundTaskAddresses, backgroundTaskStatus } from './backgroundTaskPresentation';
import { backgroundRunSource, type StopRequest } from './backgroundRuntimeState';

export function BackgroundRunDetails({ task, sources, isZh, request, onConfirm, onCancel, onStop, onSource }: {
  readonly task: ManagedShellTask;
  readonly sources: readonly { id: string; title: string }[] | null;
  readonly isZh: boolean;
  readonly request: StopRequest | null;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  readonly onStop: () => void;
  readonly onSource?: (id: string) => void;
}) {
  const source = backgroundRunSource(task, sources, isZh);
  const cancel = useRef<HTMLButtonElement>(null);
  const output = useRef<HTMLPreElement>(null);
  const following = useRef(true);
  const [copyError, setCopyError] = useState('');
  useEffect(() => { if (request?.phase === 'confirm') cancel.current?.focus(); }, [request?.phase]);
  useEffect(() => {
    if (following.current && output.current) output.current.scrollTop = output.current.scrollHeight;
  }, [task.stdout, task.stderr]);
  const title = task.description?.trim() || task.command || task.taskId;
  return <section className="background-run-detail">
    <h3>{title}</h3>
    <p role="status">{backgroundTaskStatus(task, isZh)}</p>
    <p>{isZh ? '来源' : 'Source'} · {source.id && onSource
      ? <button type="button" onClick={() => onSource(source.id!)}>{source.label}</button> : source.label}</p>
    <p className="background-run-meta">{(task.cwd ?? '').split(/[\\/]/).filter(Boolean).pop() || '—'}</p>
    {task.startedAt && <p className="background-run-meta">{isZh ? '开始于' : 'Started'} {new Date(task.startedAt).toLocaleString()}</p>}
    <div className="background-run-listeners">
      {backgroundTaskAddresses(task).map((address) => <p key={address}><code>{address}</code> <button type="button" onClick={() => {
        void navigator.clipboard.writeText(address).then(() => setCopyError(''), () => setCopyError(isZh ? '复制失败' : 'Copy failed'));
      }}>{isZh ? '复制' : 'Copy'}</button></p>)}
      <p className="background-run-meta">{backgroundTaskAddresses(task).length
        ? (isZh ? '仅表示 TCP 监听，不代表服务就绪' : 'TCP listener only; not service readiness')
        : (isZh ? '未观测到监听地址' : 'No observed listener')}</p>
      {copyError && <p role="alert">{copyError}</p>}
    </div>
    <details><summary>{isZh ? '日志' : 'Logs'}</summary>
      <p className="background-run-meta">{isZh ? '最近输出（可能截断）' : 'Recent output (may be truncated)'}</p>
      <pre ref={output} className="background-run-output" onScroll={() => {
        const node = output.current;
        if (node) following.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24;
      }}>{`stdout\n${task.stdout || '—'}\n\nstderr\n${task.stderr || '—'}`}</pre>
      <button type="button" onClick={() => { following.current = true; if (output.current) output.current.scrollTop = output.current.scrollHeight; }}>{isZh ? '回到最新' : 'Latest output'}</button>
      <p className="background-run-meta">{task.artifactRef || (isZh ? '日志证据暂不可用' : 'Log evidence unavailable')}</p>
    </details>
    <details><summary>{isZh ? '技术信息' : 'Technical information'}</summary>
      <dl>{[
        [isZh ? '命令' : 'Command', task.command], ['cwd', task.cwd],
        [isZh ? '运行 ID' : 'Run ID', task.taskId], [isZh ? '工具调用' : 'Tool call', task.toolCallId],
        [isZh ? '结束时间' : 'Ended', task.completedAt], ['Exit code', task.exitCode],
        ['Evidence', task.artifactRef],
      ].map(([label, value]) => <div key={String(label)}><dt>{label}</dt><dd><pre>{value ?? '—'}</pre></dd></div>)}</dl>
    </details>
    {request?.phase === 'confirm' ? <div className="background-run-confirm">
      <p>{isZh ? `停止「${title}」？它可能仍被使用，停止不会撤销已写入的文件。` : `Stop “${title}”? It may still be in use. Written files will not be undone.`}</p>
      <button ref={cancel} type="button" onClick={onCancel}>{isZh ? '取消' : 'Cancel'}</button>
      <button type="button" className="background-run-destructive" onClick={onStop}>{isZh ? '停止运行' : 'Stop run'}</button>
    </div> : <>
      {request && <p role={request.phase === 'rejected' ? 'alert' : 'status'}>{request.phase === 'requesting'
        ? (isZh ? '正在请求停止' : 'Requesting stop')
        : request.phase === 'unconfirmed' ? (isZh ? '尚未确认停止' : 'Stop not yet confirmed') : request.error}</p>}
      {task.status === 'running' && <button type="button" disabled={request?.phase === 'requesting' || request?.phase === 'unconfirmed'} onClick={onConfirm}>{isZh ? '停止…' : 'Stop…'}</button>}
    </>}
  </section>;
}

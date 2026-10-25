import { useMemo, useState } from 'react';
import { clientApi } from '../clientApi';
import { useResourceRead } from '../ui/resources/useResourceState';
import { useResourceWorkspace } from './ResourceWorkspaceContext';
import { useWorkbench } from './WorkbenchContext';
import { DiffViewer } from './file-preview/DiffViewer';
import { comparisonReadError, resourceDiffFiles, taskComparisonBinding } from './resourceComparisonState';

function ComparisonRead({ workspaceId, path, root, active, isZh, fromRef = 'HEAD', toRef, comparison }: {
  readonly workspaceId: string; readonly path: string; readonly root: string; readonly active: boolean; readonly isZh: boolean;
  readonly fromRef?: string; readonly toRef?: string; readonly comparison?: 'working' | 'staged';
}) {
  const workspace = useResourceWorkspace();
  const workbench = useWorkbench();
  const [selected, setSelected] = useState<string | null>(null);
  const reference = { workspaceId, path, kind: 'directory' as const };
  const read = useResourceRead(JSON.stringify([reference, fromRef, toRef, comparison]), () => clientApi.gitDiffRange({
    workspaceRoot: root, fromRef, ...(toRef ? { toRef } : {}), ...(comparison ? { comparison } : {}), documentReference: reference,
  }), active);
  const value = read.value;
  const files = useMemo(() => resourceDiffFiles(value?.ok ? value.diffText : ''), [value]);
  const file = files.find(item => item.key === selected) ?? files[0];
  const repo = value?.workspaceRoot;
  const currentFile = repo && file?.path ? `${repo.replace(/[/\\]+$/, '')}/${file.path}` : null;
  return <section className="resource-comparison" aria-busy={read.loading}>
    <div className="resource-changes-toolbar">
      <span className="resource-source-label">{comparison === 'working' ? (isZh ? '暂存区 → 当前工作树' : 'Index → working tree')
        : comparison === 'staged' ? `HEAD → ${isZh ? '暂存区' : 'Index'}` : `${value?.fromRef ?? fromRef} → ${value?.toRef ?? (isZh ? '当前工作树' : 'Working tree')}`}</span>
      <button className="ui-button is-compact" type="button" disabled={read.loading} onClick={() => void read.reload()}>{isZh ? '刷新' : 'Refresh'}</button>
    </div>
    <p className="resource-source-label">{root}</p>
    {read.error || value && !value.ok ? <p role="alert">{comparisonReadError(value?.status, value?.error, isZh)}{value?.ok ? (isZh ? ' 仍显示上次读取的内容。' : ' Previous content is still shown.') : ''}</p> : null}
    {!read.loaded && !read.error ? <p role="status">{isZh ? '正在读取更改…' : 'Reading changes…'}</p> : null}
    {value?.ok ? <>
      {files.length ? <>
        <nav className="resource-diff-index" aria-label={isZh ? '变更文件' : 'Changed files'}>
          {files.map(item => <button key={item.key} type="button" className="resource-diff-file" aria-pressed={file?.key === item.key} onClick={() => setSelected(item.key)}>
            <span>{item.path || (isZh ? '比较内容' : 'Comparison')}</span><small>{item.binary ? (isZh ? '二进制' : 'Binary') : `+${item.additions} / −${item.deletions}`}</small>
          </button>)}
        </nav>
        {file ? <>
          <div className="resource-changes-toolbar"><span className="resource-document-name" title={file.path}>{file.path}</span>
            <button type="button" className="ui-button is-compact" disabled={!currentFile || file.removed}
              title={file.removed ? (isZh ? '文件已删除，仍可阅读下面的变更。' : 'The file was deleted. Its changes remain readable below.') : undefined}
              onClick={() => { if (currentFile) workspace?.openReference({ workspaceId, path: currentFile }); }}>{isZh ? '打开当前文件' : 'Open current file'}</button>
          </div>
          {file.binary ? <p role="status">{isZh ? '这是二进制变更，无法显示文本差异。' : 'This is a binary change. Text differences are unavailable.'}</p>
            : <DiffViewer diffText={file.raw} showFileHeaders showFileIndex={false} isZh={isZh} />}
        </> : null}
      </> : <p role="status">{isZh ? '此范围没有已跟踪文件的改动。' : 'No tracked changes in this range.'}</p>}
      {value.untracked?.length ? <div className="resource-untracked"><h3>{isZh ? '未跟踪文件' : 'Untracked files'}</h3>
        {value.untracked.map(target => <button className="ui-button" type="button" key={target}
          onClick={() => workbench.openFile(target, undefined, undefined, { preferredMode: 'diff', reference: { workspaceId, path: target } })}>{target}</button>)}
        {value.untrackedTruncated ? <p role="status">{isZh ? '列表未完整显示，请在目录中继续查看。' : 'The list is incomplete. Continue in Files.'}</p> : null}
      </div> : null}
    </> : null}
  </section>;
}

function TaskComparison({ workspaceId, active, isZh }: { readonly workspaceId: string; readonly active: boolean; readonly isZh: boolean }) {
  const [sessionId, setSessionId] = useState('');
  const sessions = useResourceRead(workspaceId, () => clientApi.projectAgentListSessions({ workspaceId, limit: 40 }), active);
  const items = useMemo(() => (sessions.value?.sessions ?? []).flatMap(raw => {
    if (!raw || typeof raw !== 'object') return [];
    const item = raw as { workspaceId?: string; sessionId?: string; title?: string };
    return item.workspaceId === workspaceId && typeof item.sessionId === 'string' ? [{ id: item.sessionId, title: item.title || item.sessionId }] : [];
  }), [sessions.value, workspaceId]);
  const selectedExists = items.some(item => item.id === sessionId);
  const source = useResourceRead(`${workspaceId}:${sessionId}`, async () => {
    const result = await clientApi.projectAgentGetSession({ sessionId, detail: 'report' });
    const detail = result.session as { report?: { planId?: string } } | undefined;
    if (!result.ok || !detail?.report?.planId) return null;
    const plan = await clientApi.goalPlansGet({ planId: detail.report.planId });
    return taskComparisonBinding(detail, plan, workspaceId, sessionId);
  }, active && !!sessionId && selectedExists);
  return <>
    <div className="resource-changes-toolbar">
      <select aria-label={isZh ? '任务比较来源' : 'Task comparison source'} value={sessionId} onChange={event => setSessionId(event.target.value)}>
        <option value="">{isZh ? '选择任务' : 'Choose a task'}</option>
        {items.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
      </select>
      <button className="ui-button is-compact" type="button" disabled={sessions.loading} onClick={() => void sessions.reload()}>{isZh ? '刷新任务' : 'Refresh tasks'}</button>
    </div>
    {sessions.error || sessions.value && !sessions.value.ok ? <p role="alert">{isZh ? '无法读取任务来源，请重试。' : 'Task sources could not be read. Retry.'}</p>
      : sessions.loaded && !items.length ? <p role="status">{isZh ? '此机器人暂时没有可选任务。' : 'This Bot has no available tasks.'}</p> : null}
    {sessionId && sessions.loaded && !selectedExists ? <p role="status">{isZh ? '所选任务已不在当前列表中，请重新选择。' : 'The selected task is no longer in this list. Choose another task.'}</p> : null}
    {selectedExists && source.loading ? <p role="status">{isZh ? '正在核对任务比较起点…' : 'Checking the task baseline…'}</p> : null}
    {selectedExists && (source.loaded || source.error) && !source.value ? <p role="alert">{isZh ? '此任务缺少可确认的仓库或起始提交，无法自动比较。现有成果保留。' : 'This task has no confirmed repository or baseline commit. Existing work is preserved.'}</p> : null}
    {selectedExists && source.value ? <>
      <p className="resource-source-label">{source.value.isolated
        ? (isZh ? '任务起点与任务工作树的当前内容比较；不代表已验收交付。' : 'Task baseline compared with its current worktree; not an accepted delivery.')
        : (isZh ? '此任务未隔离执行，比较可能包含其他本地改动。' : 'This task is not isolated. The comparison may include other local changes.')}</p>
      <ComparisonRead key={`${sessionId}:${source.value.root}:${source.value.base}`} workspaceId={workspaceId} path={source.value.root}
        root={source.value.root} fromRef={source.value.base} active={active} isZh={isZh} />
    </> : null}
  </>;
}

export function ResourceChanges({ workspaceId, path, root, isZh, active }: {
  readonly workspaceId: string; readonly path: string; readonly root: string; readonly isZh: boolean; readonly active: boolean;
}) {
  const [mode, setMode] = useState<'working' | 'staged' | 'range' | 'task'>('working');
  const [from, setFrom] = useState('HEAD'), [to, setTo] = useState('');
  const [range, setRange] = useState({ from: 'HEAD', to: '' });
  return <section className="resource-changes">
    <div className="resource-changes-toolbar"><select aria-label={isZh ? '比较范围' : 'Comparison'} value={mode}
      onChange={event => setMode(event.target.value as typeof mode)}>
      <option value="working">{isZh ? '未暂存' : 'Unstaged'}</option><option value="staged">{isZh ? '已暂存' : 'Staged'}</option>
      <option value="range">{isZh ? '提交比较' : 'Compare revisions'}</option><option value="task">{isZh ? '任务来源' : 'Task source'}</option>
    </select></div>
    {mode === 'range' ? <form className="resource-range" onSubmit={event => { event.preventDefault(); setRange({ from: from.trim(), to: to.trim() }); }}>
      <input aria-label={isZh ? '起始引用' : 'Base revision'} value={from} onChange={event => setFrom(event.target.value)} />
      <input aria-label={isZh ? '目标引用（空为工作树）' : 'Target revision (empty for working tree)'} value={to} onChange={event => setTo(event.target.value)} />
      <button type="submit" className="ui-button">{isZh ? '比较' : 'Compare'}</button>
    </form> : null}
    {mode === 'task' ? <TaskComparison workspaceId={workspaceId} active={active} isZh={isZh} />
      : <ComparisonRead workspaceId={workspaceId} path={path} root={root} active={active} isZh={isZh}
        fromRef={mode === 'range' ? range.from : 'HEAD'} toRef={mode === 'range' ? range.to : undefined}
        comparison={mode === 'range' ? undefined : mode} />}
    {mode !== 'task' ? <p className="resource-source-label">{isZh ? '所选仓库的当前比较，可能包含已有本地改动。' : 'Current comparison of the selected repository; may include existing local changes.'}</p> : null}
  </section>;
}

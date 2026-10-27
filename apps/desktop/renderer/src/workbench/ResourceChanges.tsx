import { useMemo, useRef, useState } from 'react';
import { clientApi } from '../clientApi';
import { useResourceRead } from '../ui/resources/useResourceState';
import { taskComparisonBinding } from './resourceComparisonState';
import { ComparisonRead } from './ComparisonRead';
export { ComparisonRead } from './ComparisonRead';


function TaskComparison({ workspaceId, active, isZh }: { readonly workspaceId: string; readonly active: boolean; readonly isZh: boolean }) {
  const [sessionId, setSessionId] = useState('');
  const sessions = useResourceRead(workspaceId, () => clientApi.projectAgentListSessions({ workspaceId, limit: 40 }), active);
  const items = useMemo(() => (sessions.value?.sessions ?? []).flatMap(raw => {
    if (!raw || typeof raw !== 'object') return [];
    const item = raw as { workspaceId?: string; sessionId?: string; title?: string };
    return item.workspaceId === workspaceId && typeof item.sessionId === 'string' ? [{ id: item.sessionId, title: item.title || item.sessionId }] : [];
  }), [sessions.value, workspaceId]);
  const selectedExists = items.some(item => item.id === sessionId);
  const selection = `${workspaceId}:${sessionId}:${active}`;
  const latest = useRef(selection); latest.current = selection;
  const source = useResourceRead(`${workspaceId}:${sessionId}`, async () => {
    const result = await clientApi.projectAgentGetSession({ sessionId, detail: 'report' });
    const detail = result.session as { report?: { planId?: string } } | undefined;
    if (!result.ok || !detail?.report?.planId) return null;
    const plan = await clientApi.goalPlansGet({ planId: detail.report.planId });
    return taskComparisonBinding(detail, plan, workspaceId, sessionId);
  }, active && !!sessionId && selectedExists);
  const refreshSources = async () => {
    if (!await sessions.reload() || latest.current !== selection || !active || !sessionId) return;
    const stillListed = sessions.snapshot().value?.sessions?.some(raw => {
      const item = raw as { workspaceId?: string; sessionId?: string } | null;
      return item?.workspaceId === workspaceId && item.sessionId === sessionId;
    });
    if (stillListed) await source.reload();
  };
  return <>
    <div className="resource-changes-toolbar">
      <select aria-label={isZh ? '任务比较来源' : 'Task comparison source'} value={sessionId} onChange={event => setSessionId(event.target.value)}>
        <option value="">{isZh ? '选择任务' : 'Choose a task'}</option>
        {items.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
      </select>
      <button className="ui-button is-compact" type="button" disabled={sessions.loading || source.loading && !!sessionId} onClick={refreshSources}>{isZh ? '刷新任务' : 'Refresh tasks'}</button>
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
        root={source.value.root} fromRef={source.value.base} active={active} isZh={isZh} task={source.value.task} />
    </> : null}
  </>;
}

export function ResourceChanges({ workspaceId, path, root, isZh, active }: {
  readonly workspaceId: string; readonly path: string; readonly root: string; readonly isZh: boolean; readonly active: boolean;
}) {
  const [mode, setMode] = useState<'working' | 'staged' | 'range' | 'task'>('working');
  const [from, setFrom] = useState('HEAD'), [to, setTo] = useState('');
  const [range, setRange] = useState({ from: 'HEAD', to: '', revision: 0 });
  return <section className="resource-changes">
    <div className="resource-changes-toolbar"><select aria-label={isZh ? '比较范围' : 'Comparison'} value={mode}
      onChange={event => setMode(event.target.value as typeof mode)}>
      <option value="working">{isZh ? '未暂存' : 'Unstaged'}</option><option value="staged">{isZh ? '已暂存' : 'Staged'}</option>
      <option value="range">{isZh ? '提交比较' : 'Compare revisions'}</option><option value="task">{isZh ? '任务来源' : 'Task source'}</option>
    </select></div>
    {mode === 'range' ? <form className="resource-range" onSubmit={event => { event.preventDefault(); setRange(current => ({ from: from.trim(), to: to.trim(), revision: current.revision + 1 })); }}>
      <input aria-label={isZh ? '起始引用' : 'Base revision'} value={from} onChange={event => setFrom(event.target.value)} />
      <input aria-label={isZh ? '目标引用（空为工作树）' : 'Target revision (empty for working tree)'} value={to} onChange={event => setTo(event.target.value)} />
      <button type="submit" className="ui-button">{isZh ? '比较' : 'Compare'}</button>
    </form> : null}
    {(['working', 'staged', 'range', 'task'] as const).map(view => <div key={view} hidden={mode !== view} inert={mode !== view}
      aria-hidden={mode !== view} style={mode !== view ? { display: 'none' } : undefined}>
      {view === 'task' ? <TaskComparison workspaceId={workspaceId} active={active && mode === view} isZh={isZh} />
        : <ComparisonRead key={view === 'range' ? range.revision : view} workspaceId={workspaceId} path={path} root={root}
          active={active && mode === view} isZh={isZh} fromRef={view === 'range' ? range.from : 'HEAD'}
          toRef={view === 'range' ? range.to : undefined} comparison={view === 'range' ? undefined : view} />}
    </div>)}
    {mode !== 'task' ? <p className="resource-source-label">{isZh ? '所选仓库的当前比较，可能包含已有本地改动。' : 'Current comparison of the selected repository; may include existing local changes.'}</p> : null}
  </section>;
}

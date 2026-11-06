import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useWorkbench } from './WorkbenchContext';
import { useResourceWorkspace } from './ResourceWorkspaceContext';
import { activateDocumentTab, documentComparisonLabel } from './documentSessionState';
import type { resourceDiffFiles } from './resourceComparisonState';
import { comparisonSourceLabel } from './resourceNavigationState';

type Index = { readonly workspaceId: string; readonly identity: string; readonly viewId: string; readonly root: string;
  readonly files: ReturnType<typeof resourceDiffFiles>; readonly selected: string | null; readonly select: (key: string) => void };
const Context = createContext<{ index: Index | null; publish: (value: Index) => void; retire: (identity: string, viewId: string) => void } | null>(null);
/** Presentation projection only: no second reader, source registry or comparison authority. */
export function ComparisonNavigationProvider({ workspaceId, children }: { readonly workspaceId: string; readonly children: ReactNode }) {
  const [index, setIndex] = useState<Index | null>(null);
  useLayoutEffect(() => setIndex(current => current?.workspaceId === workspaceId ? current : null), [workspaceId]);
  const owner = useRef(workspaceId); owner.current = workspaceId;
  const publish = useCallback((next: Index) => { if (next.workspaceId === owner.current) setIndex(next); }, []);
  const retire = useCallback((identity: string, viewId: string) => setIndex(value => value?.identity === identity && value.viewId === viewId ? null : value), []);
  const value = useMemo(() => ({ index: index?.workspaceId === workspaceId ? index : null, publish, retire }), [index, workspaceId, publish, retire]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function usePublishComparisonIndex(index: Index, active: boolean) {
  const bridge = useContext(Context), publish = bridge?.publish, retire = bridge?.retire;
  useEffect(() => { if (!active) return; publish?.(index); return () => retire?.(index.identity, index.viewId); }, [active, index, publish, retire]);
}
export function ComparisonNavigator({ isZh }: { readonly isZh: boolean }) {
  const published = useContext(Context)?.index, workbench = useWorkbench(), workspace = useResourceWorkspace();
  const index = published && (workbench.activeTab === 'documents' && published.viewId === workbench.documentSession.activeTabId
    || workbench.activeTab === 'changes' && published.viewId === 'changes') ? published : null;
  const tabs = workbench.documentSession.tabs.filter(tab => tab.comparison);
  return <div className="resource-comparison-navigator">
    <div className="resource-source-picker">
      {(['.', 'Peer-Knowledge'] as const).map(path => <button key={path} type="button" className="ui-button is-compact" onClick={() => {
        const workspaceId = workspace?.owner?.workspaceId;
        if (workspaceId) workspace.openComparison({ workspaceId, path, kind: 'directory' }, { fromRef: 'HEAD', comparison: 'working' });
      }}>{path === '.' ? (isZh ? '项目变更' : 'Project changes') : (isZh ? '知识库变更' : 'Knowledge changes')}</button>)}
      <button className="ui-button is-compact" type="button" onClick={() => workbench.setActiveTab('changes')}>{isZh ? '更多比较来源' : 'More comparison sources'}</button>
    </div>
    {tabs.length ? <nav aria-label={isZh ? '已打开的比较' : 'Open comparisons'}>{tabs.map(tab => <button key={tab.id} className="ui-button resource-comparison-target" type="button"
      aria-pressed={workbench.activeTab === 'documents' && tab.id === workbench.documentSession.activeTabId} title={`${tab.absPath} · ${documentComparisonLabel(tab.comparison!, isZh)}`}
      onClick={() => { workbench.setDocumentSession(current => activateDocumentTab(current, tab.id)); workbench.setActiveTab('documents'); }}>
      <span>{comparisonSourceLabel(tab.absPath, isZh)}</span><small>{documentComparisonLabel(tab.comparison!, isZh)}</small>
    </button>)}</nav> : null}
    {index ? <><p className="resource-source-label">{index.root}</p><nav aria-label={isZh ? '当前比较文件' : 'Current comparison files'}>
      {index.files.map(file => <button className="ui-button resource-comparison-target" type="button" key={file.key} aria-pressed={file.key === index.selected}
        onClick={() => index.select(file.key)}><span>{file.path || (isZh ? '原始差异' : 'Raw diff')}</span><small>+{file.additions} −{file.deletions}</small></button>)}
    </nav></> : <p className="resource-source-label">{isZh ? '打开一个比较，查看其中的文件。' : 'Open a comparison to browse its files.'}</p>}
  </div>;
}

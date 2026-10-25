import { useResourceWorkspace } from './ResourceWorkspaceContext';
import { PeerIcon } from '../ui/icons';
import { ResourceTabStrip } from './ResourceTabStrip';
import { useWorkbench } from './WorkbenchContext';
import { LAUNCHER_TAB } from './resourceWorkspaceState';
import type { useResourcePresentation } from './useResourcePresentation';

export function ResourceWorkspaceHeader({ isZh, presentation, idPrefix }: {
  readonly isZh: boolean; readonly presentation: ReturnType<typeof useResourcePresentation>; readonly idPrefix: string;
}) {
  const workbench = useWorkbench();
  const workspace = useResourceWorkspace();
  const items = presentation.resources.map(item => ({ id: item.key, label: item.label, title: item.title,
    controls: `${idPrefix}-content`, icon: <PeerIcon name={item.kind === 'browser' ? 'globe' : 'fileText'} size={14} /> }));
  if (workbench.activeTab === 'launcher' || items.length === 0) items.push({ id: LAUNCHER_TAB,
    label: isZh ? '新标签页' : 'New tab', title: isZh ? '新标签页' : 'New tab', controls: `${idPrefix}-content`, icon: <PeerIcon name="plus" size={14} /> });
  return <header className="resource-workspace-header">
    <ResourceTabStrip ensureActiveVisible idPrefix={idPrefix} ariaLabel={isZh ? '资源标签' : 'Resource tabs'} items={items}
      activeId={presentation.active} closeLabel={isZh ? '关闭标签' : 'Close tab'}
      onActivate={presentation.activate} onClose={key => {
        if (key === LAUNCHER_TAB && presentation.resources.length === 0) workspace?.close(); else presentation.close(key);
      }}
      action={{ label: isZh ? '新标签页' : 'New tab', icon: <PeerIcon name="plus" size={16} />, onClick: presentation.launch }} />
    <div className="resource-workspace-controls">
      <button type="button" className="ui-button" onClick={() => workbench.setActiveTab('browser')} title={isZh ? '网页' : 'Browser'} aria-label={isZh ? '打开网页视图' : 'Open browser view'}><PeerIcon name="globe" size={16} /></button>
      <button type="button" className="ui-button" onClick={() => workbench.setActiveTab('files')} title={isZh ? '目录' : 'Files'} aria-label={isZh ? '浏览目录' : 'Browse files'}><PeerIcon name="folder" size={16} /></button>
      <button type="button" className="ui-button" onClick={() => workbench.setMaximized(!workbench.maximized)} aria-pressed={workbench.maximized}
        title={workbench.maximized ? (isZh ? '恢复工作区' : 'Restore workspace') : (isZh ? '展开工作区' : 'Expand workspace')}
        aria-label={workbench.maximized ? (isZh ? '恢复工作区' : 'Restore workspace') : (isZh ? '展开工作区' : 'Expand workspace')}>
        <PeerIcon name={workbench.maximized ? 'restore' : 'maximize'} size={16} /></button>
      <button type="button" className="ui-button" onClick={() => workspace?.close()} aria-label={isZh ? '收起工作区' : 'Collapse workspace'}><PeerIcon name="close" size={16} /></button>
    </div>
  </header>;
}

import { useResourceWorkspace } from './ResourceWorkspaceContext';
import { PeerIcon, type PeerIconName } from '../ui/icons';
import { ResourceTabStrip } from './ResourceTabStrip';
import { useWorkbench } from './WorkbenchContext';
import { resourceDetailReturnLabel } from './resourceDetailState';
import { LAUNCHER_TAB } from './resourceWorkspaceState';
import type { useResourcePresentation } from './useResourcePresentation';

function tabIconForKind(kind: ReturnType<typeof useResourcePresentation>['resources'][number]['kind']): PeerIconName {
  if (kind === 'browser') return 'globe';
  if (kind === 'directory') return 'folder';
  if (kind === 'interactive') return 'blocks';
  if (kind === 'comparison') return 'history';
  if (kind === 'conversation') return 'terminal';
  return 'fileText';
}

/**
 * Browser-style resource tab header (ADR 125, 2026-11-25 Plan A amendment).
 * Left side owns mixed resource tabs + `+` launcher; right side owns only
 * panel-level window controls (expand/restore and collapse).
 */
export function ResourceWorkspaceHeader({ isZh, presentation, idPrefix }: {
  readonly isZh: boolean;
  readonly presentation: ReturnType<typeof useResourcePresentation>;
  readonly idPrefix: string;
}) {
  const workbench = useWorkbench();
  const workspace = useResourceWorkspace();
  const items = presentation.resources.map(item => ({
    id: item.key,
    label: item.label,
    title: item.title,
    controls: `${idPrefix}-content`,
    icon: <PeerIcon name={tabIconForKind(item.kind)} size={14} />,
  }));
  if (workbench.activeTab === 'launcher' || items.length === 0) {
    items.push({
      id: LAUNCHER_TAB,
      label: isZh ? '新标签页' : 'New tab',
      title: isZh ? '新标签页' : 'New tab',
      controls: `${idPrefix}-content`,
      icon: <PeerIcon name="plus" size={14} />,
    });
  }
  return <header className="resource-workspace-header">
    {workspace?.detailActive ? <div className="resource-detail-heading">
      <button className="ui-button" type="button" onClick={workspace.returnToResources}
        aria-label={isZh ? '返回资源' : 'Return to resources'} title={isZh ? '返回资源' : 'Return to resources'}><PeerIcon name="back" size={16} /></button>
      <span>{workspace.detail?.title || (isZh ? '详情' : 'Details')}</span>
    </div> : <ResourceTabStrip ensureActiveVisible idPrefix={idPrefix} ariaLabel={isZh ? '资源标签' : 'Resource tabs'} items={items}
      activeId={presentation.active} closeLabel={isZh ? '关闭标签' : 'Close tab'}
      onActivate={presentation.activate} onClose={key => {
        if (key === LAUNCHER_TAB && presentation.resources.length === 0) workspace?.close(); else presentation.close(key);
      }}
      action={{ label: isZh ? '新标签页' : 'New tab', icon: <PeerIcon name="plus" size={16} />, onClick: presentation.launch }} />}
    {!workspace?.detailActive && workspace?.returnDetail ? <button className="ui-button resource-return-detail" type="button"
      onClick={workspace.returnToDetail} title={resourceDetailReturnLabel(workspace.returnDetail, isZh)}>
      <PeerIcon name="back" size={14} /><span>{resourceDetailReturnLabel(workspace.returnDetail, isZh)}</span>
    </button> : null}
    <div className="resource-workspace-controls">
      <button type="button" className="ui-button" onClick={() => workbench.setMaximized(!workbench.maximized)} aria-pressed={workbench.maximized}
        title={workbench.maximized ? (isZh ? '恢复工作区' : 'Restore workspace') : (isZh ? '展开工作区' : 'Expand workspace')}
        aria-label={workbench.maximized ? (isZh ? '恢复工作区' : 'Restore workspace') : (isZh ? '展开工作区' : 'Expand workspace')}>
        <PeerIcon name={workbench.maximized ? 'restore' : 'maximize'} size={16} /></button>
      <button type="button" className="ui-button" onClick={() => workspace?.close()}
        title={isZh ? '收起工作区' : 'Collapse workspace'}
        aria-label={isZh ? '收起工作区' : 'Collapse workspace'}><PeerIcon name="close" size={16} /></button>
    </div>
  </header>;
}

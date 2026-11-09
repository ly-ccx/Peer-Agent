import type { useResourceNavigation } from './useResourceNavigation';
import { useResourceWorkspace } from './ResourceWorkspaceContext';
import { PeerIcon } from '../ui/icons';
import { ResourceTabStrip } from './ResourceTabStrip';
import { useWorkbench } from './WorkbenchContext';
import { resourceDetailReturnLabel } from './resourceDetailState';
import { LAUNCHER_TAB } from './resourceWorkspaceState';
import type { useResourcePresentation } from './useResourcePresentation';

export function ResourceWorkspaceHeader({ isZh, presentation, idPrefix, navigation }: {
  readonly isZh: boolean; readonly presentation: ReturnType<typeof useResourcePresentation>; readonly idPrefix: string; readonly navigation: ReturnType<typeof useResourceNavigation>;
}) {
  const workbench = useWorkbench();
  const workspace = useResourceWorkspace();
  // ADR125 决策五：launcher 是激活标签且没有任何辅助面板打开时，头部不渲染网页/目录/变更入口；
  // launcher 页内「工具」区已承载同组入口。任一辅助面板打开即恢复渲染，保住按下态、切换关闭与焦点回退。
  const bareLauncher = workbench.activeTab === 'launcher' && !navigation.mode;
  const items = presentation.resources.map(item => ({ id: item.key, label: item.label, title: item.title,
    controls: `${idPrefix}-content`, icon: <PeerIcon name={item.kind === 'browser' ? 'globe' : item.kind === 'conversation' ? 'terminal' : 'fileText'} size={14} /> }));
  if (workbench.activeTab === 'launcher' || items.length === 0) items.push({ id: LAUNCHER_TAB,
    label: isZh ? '新标签页' : 'New tab', title: isZh ? '新标签页' : 'New tab', controls: `${idPrefix}-content`, icon: <PeerIcon name="plus" size={14} /> });
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
      {!bareLauncher ? <>
        <button type="button" className="ui-button" onClick={() => { workspace?.rememberDetailSource(); workbench.setActiveTab('browser'); }} title={isZh ? '网页' : 'Browser'} aria-label={isZh ? '打开网页视图' : 'Open browser view'}><PeerIcon name="globe" size={16} /></button>
        <button type="button" className="ui-button" onClick={() => { workspace?.rememberDetailSource(); navigation.toggle('files'); }} data-navigator="files" aria-pressed={navigation.mode === 'files' || workbench.activeTab === 'files'} title={isZh ? '目录' : 'Files'} aria-label={isZh ? '浏览目录' : 'Browse files'}><PeerIcon name="folder" size={16} /></button>
        <button type="button" className="ui-button" data-navigator="changes" aria-pressed={navigation.mode === 'changes' || workbench.activeTab === 'changes'}
          onClick={() => { workspace?.rememberDetailSource(); navigation.toggle('changes'); }} title={isZh ? '变更导航' : 'Changes navigation'} aria-label={isZh ? '浏览变更' : 'Browse changes'}><PeerIcon name="fileText" size={16} /></button>
      </> : null}
      <button type="button" className="ui-button" onClick={() => workbench.setMaximized(!workbench.maximized)} aria-pressed={workbench.maximized}
        title={workbench.maximized ? (isZh ? '恢复工作区' : 'Restore workspace') : (isZh ? '展开工作区' : 'Expand workspace')}
        aria-label={workbench.maximized ? (isZh ? '恢复工作区' : 'Restore workspace') : (isZh ? '展开工作区' : 'Expand workspace')}>
        <PeerIcon name={workbench.maximized ? 'restore' : 'maximize'} size={16} /></button>
      <button type="button" className="ui-button" onClick={() => workspace?.close()} aria-label={isZh ? '收起工作区' : 'Collapse workspace'}><PeerIcon name="close" size={16} /></button>
    </div>
  </header>;
}

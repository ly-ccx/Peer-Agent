import { usePointerResize } from '../app/hooks/usePointerResize';
import { isImeKey } from '../chat/state/compositionGuard';
import { selectionNavigation } from '../app/components/selectionNavigation';
import { useEffect, useId, useRef, useState, type ReactElement } from 'react';
import { useWorkbench, type WorkbenchTabId } from './WorkbenchContext';
import { BrowserView } from './views/BrowserView';
import { FilesView } from './views/FilesView';
import { DocumentView } from './views/DocumentView';
import { ResourceWorkspaceHeader } from './ResourceWorkspaceHeader';
import { ResourceLauncher } from './ResourceLauncher';
import { ScopedResourceNavigator } from './ScopedResourceNavigator';
import { useResourcePresentation } from './useResourcePresentation';
import { resourceTabIds } from './ResourceTabStrip';
import {
  WORKBENCH_MIN_WIDTH,
  WORKBENCH_DEFAULT_WIDTH,
} from './WorkbenchContext';
import { mountedBrowserConversations, stabilizeMountedBrowserOrder } from './browserPanelReveal';
import {
  clampWorkbenchWidth,
  resolveWorkbenchResizeStage,
} from './workbenchResizeStages';

interface TabDef {
  readonly id: WorkbenchTabId;
  readonly labelZh: string;
  readonly labelEn: string;
  readonly icon: ReactElement;
}

const ICON_PROPS = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

function MaximizeIcon() {
  return (
    <svg width="16" height="16" {...ICON_PROPS}>
      <path d="M9 3H3v6M15 3h6v6M9 21H3v-6M15 21h6v-6" />
    </svg>
  );
}

function RestoreIcon() {
  return (
    <svg width="16" height="16" {...ICON_PROPS}>
      <path d="M9 3v6H3M15 3v6h6M9 21v-6H3M15 21v-6h6" />
    </svg>
  );
}

const TABS: readonly TabDef[] = [
  {
    id: 'plan',
    labelZh: '计划',
    labelEn: 'Plan',
    icon: (
      <svg width="15" height="15" {...ICON_PROPS}>
        <circle cx="12" cy="12" r="9" />
        <circle cx="12" cy="12" r="5" />
        <circle cx="12" cy="12" r="1.5" />
      </svg>
    ),
  },
  {
    id: 'browser',
    labelZh: '浏览器',
    labelEn: 'Browser',
    icon: (
      <svg width="15" height="15" {...ICON_PROPS}>
        <circle cx="12" cy="12" r="9" />
        <path d="M3 12h18" />
        <path d="M12 3a14 14 0 0 1 0 18" />
        <path d="M12 3a14 14 0 0 0 0 18" />
      </svg>
    ),
  },
  {
    id: 'files',
    labelZh: '文件',
    labelEn: 'Files',
    icon: (
      <svg width="15" height="15" {...ICON_PROPS}>
        <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
      </svg>
    ),
  },
  {
    id: 'documents',
    labelZh: '文档',
    labelEn: 'Documents',
    icon: (
      <svg width="15" height="15" {...ICON_PROPS}>
        <path d="M6 3h8l4 4v14H6z" />
        <path d="M14 3v5h5" />
        <path d="M9 13h6M9 17h6" />
      </svg>
    ),
  },
];

interface WorkbenchPanelProps {
  readonly resourceMode?: boolean;
  readonly resourceVisible?: boolean;
  readonly resourceWidthLimit?: number;
  readonly resourceExiting?: boolean;
  readonly botWorkspaceId?: string;
  readonly isZh: boolean;
  readonly workspacePath: string | null;
}

export function WorkbenchPanel({ isZh, workspacePath, resourceMode = false, resourceVisible = true, resourceWidthLimit, resourceExiting = false, botWorkspaceId }: WorkbenchPanelProps) {
  const {
    open: requestedOpen,
    width,
    maximized,
    activeTab,
    setActiveTab,
    setWidth,
    setMaximized,
    hasGoalPlan,
    registerGoalSlot,
    sidebarAutoCollapsed,
    setSidebarAutoCollapsed,
    sidebarOpen,
    conversationId,
    browserSession,
    setBrowserSession,
    setBrowserSessionFor,
    resolveBrowserSession,
    documentSession,
    setDocumentSession,
    layoutHost,
    preparedBrowserConversations,
    requestedBrowserConversations,
  } = useWorkbench();
  const interactiveOpen = requestedOpen && resourceVisible;
  const open = (requestedOpen || resourceExiting) && resourceVisible;
  const presentation = useResourcePresentation(resourceMode, isZh);
  useEffect(() => {
    if (!resourceMode && (activeTab === 'launcher' || activeTab === 'changes')) setActiveTab('documents');
  }, [resourceMode, activeTab, setActiveTab]);

  const goalSlotRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    registerGoalSlot(goalSlotRef.current);
    return () => registerGoalSlot(null);
  }, [registerGoalSlot]);

  // Electron <webview> 在宿主节点被 React 重排（insertBefore）时会销毁 guest。
  // 活页集合用 LRU，渲染顺序必须「只追加 / 只删除」，切回同一会话才能复用 WebContents。
  // 顺序只存在 ref 里：当帧就能算出稳定名单，不必 setState 再渲一次。
  const rawMountedBrowserIds = mountedBrowserConversations(
    conversationId,
    preparedBrowserConversations,
  );
  const browserMountOrderRef = useRef<string[]>([]);
  const mountedBrowserIds = stabilizeMountedBrowserOrder(
    browserMountOrderRef.current,
    rawMountedBrowserIds.filter(id => !resourceMode || browserMountOrderRef.current.includes(id)
      || requestedBrowserConversations.includes(id) || (id === conversationId && interactiveOpen && activeTab === 'browser')),
  );
  browserMountOrderRef.current = mountedBrowserIds;

  const resize = usePointerResize();
  const resizeLimit = resourceMode ? resourceWidthLimit ?? WORKBENCH_MIN_WIDTH : window.innerWidth;
  const displayedWidth = resourceMode ? Math.min(width, resizeLimit) : width;
  const tabsId = useId();
  const [focusedTab, setFocusedTab] = useState<WorkbenchTabId | null>(null);
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.isPrimary === false) return;
    const resizer = event.currentTarget, panel = panelRef.current;
    const startX = event.clientX, startWidth = maximized ? window.innerWidth : displayedWidth;
    const previousRootWidth = document.documentElement.style.getPropertyValue('--za-workbench-width');
    let nextWidth = startWidth, autoCollapsed = sidebarAutoCollapsed, liveMaximized = maximized;
    const started = resize.start(event, {
      onMove: clientX => {
        nextWidth = clampWorkbenchWidth(startWidth + startX - clientX, resizeLimit, WORKBENCH_MIN_WIDTH);
        if (layoutHost === 'root') document.documentElement.style.setProperty('--za-workbench-width', `${nextWidth}px`);
        if (panel) panel.style.width = `${nextWidth}px`;
        if (resourceMode) return; // Resource expansion belongs to the explicit header button.
        const stage = resolveWorkbenchResizeStage({ viewportWidth: window.innerWidth, workbenchWidth: nextWidth,
          sidebarOpen, sidebarAutoCollapsed: autoCollapsed, maximized: liveMaximized });
        if (sidebarOpen && stage.sidebarAutoCollapsed !== autoCollapsed) {
          autoCollapsed = stage.sidebarAutoCollapsed; setWidth(nextWidth); setSidebarAutoCollapsed(autoCollapsed);
        }
        if (stage.maximized !== liveMaximized) { liveMaximized = stage.maximized; setWidth(nextWidth); setMaximized(liveMaximized); }
      },
      onEnd: committed => {
        delete resizer.dataset.active;
        if (layoutHost === 'root') delete document.documentElement.dataset.workbenchResizing;
        if (committed) setWidth(nextWidth);
        else {
          if (panel) panel.style.width = maximized ? '100%' : `${displayedWidth}px`;
          if (layoutHost === 'root') document.documentElement.style.setProperty('--za-workbench-width', previousRootWidth || `${width}px`);
          setWidth(width); setMaximized(maximized); setSidebarAutoCollapsed(sidebarAutoCollapsed);
        }
      },
    });
    if (started) { resizer.dataset.active = 'true'; if (layoutHost === 'root') document.documentElement.dataset.workbenchResizing = 'true'; }
  };

  const onDoubleClick = () => {
    resize.cancel(); setWidth(WORKBENCH_DEFAULT_WIDTH); setMaximized(false);
    if (!resourceMode) setSidebarAutoCollapsed(false);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (isImeKey(e.nativeEvent)) return;
    const STEP = 16, current = maximized ? window.innerWidth : displayedWidth;
    const next = e.key === 'ArrowLeft' ? current + STEP : e.key === 'ArrowRight' ? current - STEP
      : e.key === 'Home' ? WORKBENCH_MIN_WIDTH : e.key === 'End' ? Math.max(WORKBENCH_MIN_WIDTH, resizeLimit) : null;
    if (next === null) return;
    e.preventDefault(); resize.cancel(); setMaximized(false); setWidth(clampWorkbenchWidth(next, resizeLimit, WORKBENCH_MIN_WIDTH));
  };

  const resizer = open ? (
    <div
      className={`workbench-resizer${resourceMode ? ' resource-workspace-resizer' : ''}`}
      role="separator"
      aria-orientation="vertical"
      aria-valuemin={WORKBENCH_MIN_WIDTH} aria-valuemax={Math.max(WORKBENCH_MIN_WIDTH, resizeLimit)} aria-valuenow={maximized ? window.innerWidth : displayedWidth}
      aria-label={isZh ? '拖拽调整工作台宽度' : 'Resize workbench'}
      aria-hidden={!interactiveOpen}
      inert={!interactiveOpen}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
      onKeyDown={onKeyDown}
    />
  ) : null;

  // Resource handles live beside the clipped paper; classic workbenches retain their host.
  // 收起态：组件保持挂载用于 Goal portal target，整体不可见。
  return (
    <>
    {resourceMode ? resizer : null}
    <aside
      ref={panelRef}
      className={`workbench-panel${resourceMode ? ' resource-workspace' : ''}${open ? ' workbench-panel--open' : ''}${maximized ? ' workbench-panel--maximized' : ''}`}
      aria-hidden={!interactiveOpen}
      inert={!interactiveOpen}
      data-resource-exiting={resourceExiting}
      style={{ width: open ? (maximized ? '100%' : `${displayedWidth}px`) : 0 }}
    >
      {!resourceMode ? resizer : null}

      {resourceMode ? <ResourceWorkspaceHeader isZh={isZh} presentation={presentation} idPrefix={tabsId} /> : <div className="workbench-tab-rail" role="tablist" aria-orientation="horizontal" aria-label={isZh ? '工作台视图' : 'Workbench views'}
        onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusedTab(null); }}>
        {TABS.map((tab) => {
          const disabled = tab.id === 'plan' && !hasGoalPlan;
          const selected = activeTab === tab.id;
          const label = disabled
            ? isZh ? '暂无计划' : 'No active plan'
            : isZh ? tab.labelZh : tab.labelEn;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={`${tabsId}-tab-${tab.id}`} aria-controls={`${tabsId}-panel-${tab.id}`}
              onFocus={() => setFocusedTab(tab.id)}
              onKeyDown={event => {
                if (isImeKey(event.nativeEvent)) return;
                const next = selectionNavigation(TABS.map(item => ({ disabled: item.id === 'plan' && !hasGoalPlan })), TABS.findIndex(item => item.id === tab.id), event.key, 'horizontal', getComputedStyle(event.currentTarget).direction === 'rtl');
                if (next === null) return; event.preventDefault();
                document.getElementById(`${tabsId}-tab-${TABS[next]!.id}`)?.focus({ preventScroll: true });
              }}
              className={`workbench-tab${selected ? ' workbench-tab--active' : ''}${
                disabled ? ' workbench-tab--disabled' : ''
              }`}
              aria-label={label}
              aria-selected={selected}
              aria-disabled={disabled}
              tabIndex={!disabled && (focusedTab ?? (activeTab === 'plan' && !hasGoalPlan ? 'browser' : activeTab)) === tab.id ? 0 : -1}
              title={label}
              onClick={() => {
                if (disabled) return;
                setActiveTab(tab.id);
              }}
            >
              <span className="workbench-tab-icon" aria-hidden="true">{tab.icon}</span>
            </button>
          );
        })}
        <button
          type="button"
          className="workbench-maximize-button"
          aria-label={maximized ? (isZh ? '恢复 Workbench' : 'Restore Workbench') : (isZh ? '放大 Workbench' : 'Maximize Workbench')}
          aria-pressed={maximized}
          title={maximized ? (isZh ? '恢复' : 'Restore') : (isZh ? '放大' : 'Maximize')}
          onClick={() => setMaximized(!maximized)}
        >
          <span aria-hidden="true">{maximized ? <RestoreIcon /> : <MaximizeIcon />}</span>
        </button>
      </div>}

      <div className="workbench-view-slot" id={resourceMode ? `${tabsId}-content` : undefined}
        role={resourceMode ? (presentation.active ? 'tabpanel' : 'region') : undefined}
        aria-labelledby={resourceMode && presentation.active ? resourceTabIds(tabsId, presentation.active).tab : undefined}>
        {resourceMode ? <div className="workbench-view" data-active={activeTab === 'launcher'} inert={activeTab !== 'launcher'} aria-hidden={activeTab !== 'launcher'}>
          <ResourceLauncher key={botWorkspaceId} isZh={isZh} active={interactiveOpen && activeTab === 'launcher'} recent={presentation.recent} onChanges={() => setActiveTab('changes')} />
        </div> : null}
        <div
          className="workbench-view workbench-view--goal"
          data-active={activeTab === 'plan'}
          role="tabpanel" id={`${tabsId}-panel-plan`} aria-labelledby={`${tabsId}-tab-plan`} tabIndex={0} inert={activeTab !== 'plan'} aria-hidden={activeTab !== 'plan'}
          ref={goalSlotRef}
        />
        {mountedBrowserIds.map((id) => (
          <div
            key={`mounted-browser-${id}`}
            className={`workbench-view workbench-view--browser${id === conversationId ? '' : ' workbench-view--prepared-browser'}`}
            data-active={id === conversationId ? activeTab === 'browser' : false}
            role={id === conversationId ? 'tabpanel' : undefined} id={id === conversationId ? `${tabsId}-panel-browser` : undefined}
            aria-labelledby={id === conversationId ? `${tabsId}-tab-browser` : undefined}
            tabIndex={0} inert={id !== conversationId || activeTab !== 'browser'}
            aria-hidden={id !== conversationId || activeTab !== 'browser'}
          >
            <BrowserView
              isZh={isZh}
              conversationId={id}
              session={id === conversationId ? browserSession : resolveBrowserSession(id)}
              onSessionChange={id === conversationId
                ? setBrowserSession
                : (next) => setBrowserSessionFor(id, next)}
              claimForeground={id === conversationId && (!resourceMode || interactiveOpen && activeTab === 'browser')}
              hideTabStrip={resourceMode} lazyTabs={resourceMode} suspendBlank={resourceMode && activeTab !== 'browser'}
            />
          </div>
        ))}
        <div
          className="workbench-view workbench-view--files"
          data-active={activeTab === 'files'}
          role="tabpanel" id={`${tabsId}-panel-files`} aria-labelledby={`${tabsId}-tab-files`} tabIndex={0} inert={activeTab !== 'files'} aria-hidden={activeTab !== 'files'}
        >
          {resourceMode ? <ScopedResourceNavigator key={botWorkspaceId} isZh={isZh} active={interactiveOpen && activeTab === 'files'} />
            : <FilesView isZh={isZh} workspacePath={workspacePath} />}
        </div>
        <div
          className="workbench-view workbench-view--documents"
          data-active={activeTab === 'documents'}
          role="tabpanel" id={`${tabsId}-panel-documents`} aria-labelledby={`${tabsId}-tab-documents`} tabIndex={0} inert={activeTab !== 'documents'} aria-hidden={activeTab !== 'documents'}
        >
          {(!resourceMode || !!botWorkspaceId && !!conversationId) ? <DocumentView
            isZh={isZh}
            session={documentSession}
            onSessionChange={setDocumentSession}
            onBrowseFiles={() => setActiveTab('files')}
            hideTabStrip={resourceMode} botWorkspaceId={resourceMode ? botWorkspaceId : undefined}
            visible={!resourceMode || interactiveOpen && activeTab === 'documents'}
          /> : null}
        </div>
        {resourceMode ? <div className="workbench-view" data-active={activeTab === 'changes'} inert={activeTab !== 'changes'} aria-hidden={activeTab !== 'changes'}>
          <ScopedResourceNavigator key={botWorkspaceId} isZh={isZh} changes active={interactiveOpen && activeTab === 'changes'} />
        </div> : null}

      </div>
    </aside>
    </>
  );
}

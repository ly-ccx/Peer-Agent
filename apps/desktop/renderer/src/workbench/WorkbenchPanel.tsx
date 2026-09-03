import { useEffect, useRef, type ReactElement } from 'react';
import { useWorkbench, type WorkbenchTabId } from './WorkbenchContext';
import { BrowserView } from './views/BrowserView';
import { FilesView } from './views/FilesView';
import { DocumentView } from './views/DocumentView';
import { BackgroundThreadsView } from './views/BackgroundThreadsView';
import {
  WORKBENCH_MIN_WIDTH,
  WORKBENCH_MAX_WIDTH,
  WORKBENCH_DEFAULT_WIDTH,
} from './WorkbenchContext';
import { mountedBrowserConversations } from './browserPanelReveal';
import {
  WORKBENCH_MAXIMIZE_RATIO,
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
  {
    id: 'threads',
    labelZh: '后台线程',
    labelEn: 'Threads',
    icon: (
      <svg width="15" height="15" {...ICON_PROPS}>
        <path d="M4 6h16" />
        <path d="M4 12h16" />
        <path d="M4 18h10" />
        <circle cx="18" cy="18" r="2" />
      </svg>
    ),
  },
];

interface WorkbenchPanelProps {
  readonly isZh: boolean;
  readonly workspacePath: string | null;
}

export function WorkbenchPanel({ isZh, workspacePath }: WorkbenchPanelProps) {
  const {
    open,
    width,
    maximized,
    activeTab,
    setActiveTab,
    setWidth,
    setMaximized,
    focusThreadTaskId,
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
  } = useWorkbench();

  const goalSlotRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    registerGoalSlot(goalSlotRef.current);
    return () => registerGoalSlot(null);
  }, [registerGoalSlot]);

  // 拖拽分隔线。
  // Electron <webview> 会在 guest 层吃掉 pointerup：分隔条停在 data-active，
  // 跟手宽度也写不回去。拖拽会话必须 pointer capture + cancel 清理，
  // 并关掉 width/grid 过渡、暂时禁用 webview 的 pointer-events。
  const draggingRef = useRef(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(width);

  const onPointerDown = (ev: React.PointerEvent<HTMLDivElement>) => {
    ev.preventDefault();
    const resizer = ev.currentTarget;
    const pointerId = ev.pointerId;
    resizer.dataset.active = 'true';
    draggingRef.current = true;
    startXRef.current = ev.clientX;
    startWidthRef.current = maximized ? window.innerWidth : width;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    if (layoutHost === 'root') {
      document.documentElement.dataset.workbenchResizing = 'true';
    }
    try {
      resizer.setPointerCapture(pointerId);
    } catch {
      // pointer 可能已离开；后续仍靠 window 监听与 webview pointer-events 兜底。
    }

    // 上限跟全屏比例链走：至少能拖过 WORKBENCH_MAXIMIZE_RATIO（0.8）进全屏，实际允许拖满窗口。
    const computeUpper = () =>
      Math.max(WORKBENCH_MIN_WIDTH, Math.floor(window.innerWidth * Math.max(1, WORKBENCH_MAXIMIZE_RATIO)));

    // 拖拽期间本地跟踪渐进阶段，避免每帧 setState；仅在阈值穿越时落 React 状态。
    let autoCollapsed = sidebarAutoCollapsed;
    let liveMaximized = maximized;
    let rafId = 0;
    let pendingWidth: number | null = null;

    const applyWidth = (next: number) => {
      if (layoutHost === 'root') {
        document.documentElement.style.setProperty('--za-workbench-width', `${next}px`);
      }
      // 面板宽度走 inline style（抽屉/local host 不投影到 :root CSS 变量）。
      const panel = resizer.parentElement;
      if (panel) panel.style.width = `${next}px`;

      const stage = resolveWorkbenchResizeStage({
        viewportWidth: window.innerWidth,
        workbenchWidth: next,
        sidebarOpen,
        sidebarAutoCollapsed: autoCollapsed,
        maximized: liveMaximized,
      });
      // 仅当用户未「主动收起」左栏时，右侧拖拽才有权自动收/展左栏。
      // 阶段切换会触发 React 重绘，必须同步 width，否则 inline 跟手宽度会被旧 state 冲掉。
      if (sidebarOpen && stage.sidebarAutoCollapsed !== autoCollapsed) {
        autoCollapsed = stage.sidebarAutoCollapsed;
        setWidth(next);
        setSidebarAutoCollapsed(autoCollapsed);
      }
      if (stage.maximized !== liveMaximized) {
        liveMaximized = stage.maximized;
        setWidth(next);
        setMaximized(liveMaximized);
      }
    };

    const flush = () => {
      rafId = 0;
      if (pendingWidth == null) return;
      const next = pendingWidth;
      pendingWidth = null;
      applyWidth(next);
    };

    const onMove = (e: PointerEvent) => {
      if (!draggingRef.current) return;
      const dx = startXRef.current - e.clientX;
      pendingWidth = clampWorkbenchWidth(
        startWidthRef.current + dx,
        computeUpper(),
        WORKBENCH_MIN_WIDTH,
      );
      if (!rafId) rafId = requestAnimationFrame(flush);
    };

    const onUp = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
      flush();
      delete resizer.dataset.active;
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      delete document.documentElement.dataset.workbenchResizing;
      try {
        if (resizer.hasPointerCapture(pointerId)) {
          resizer.releasePointerCapture(pointerId);
        }
      } catch {
        // already released
      }
      const panel = resizer.parentElement;
      const fromPanel = panel ? parseInt(panel.style.width, 10) : NaN;
      const fromVar = parseInt(
        document.documentElement.style.getPropertyValue('--za-workbench-width'),
        10,
      );
      const finalWidth = Number.isFinite(fromPanel) ? fromPanel : fromVar;
      if (Number.isFinite(finalWidth)) setWidth(finalWidth);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      window.removeEventListener('blur', onUp);
      resizer.removeEventListener('lostpointercapture', onUp);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    window.addEventListener('blur', onUp);
    resizer.addEventListener('lostpointercapture', onUp);
  };

  const onDoubleClick = () => {
    setWidth(WORKBENCH_DEFAULT_WIDTH);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const STEP = 16;
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      setWidth(width + STEP);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      setWidth(width - STEP);
    } else if (e.key === 'Home') {
      e.preventDefault();
      setWidth(WORKBENCH_MAX_WIDTH);
    } else if (e.key === 'End') {
      e.preventDefault();
      setWidth(WORKBENCH_MIN_WIDTH);
    }
  };

  // 收起态：组件保持挂载用于 Goal portal target，整体不可见。
  return (
    <aside
      className={`workbench-panel${open ? ' workbench-panel--open' : ''}${maximized ? ' workbench-panel--maximized' : ''}`}
      aria-hidden={!open}
      style={{ width: open ? (maximized ? '100%' : `${width}px`) : 0 }}
    >
      {open ? (
        <div
          className="workbench-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label={isZh ? '拖拽调整工作台宽度' : 'Resize workbench'}
          tabIndex={0}
          onPointerDown={onPointerDown}
          onDoubleClick={onDoubleClick}
          onKeyDown={onKeyDown}
        />
      ) : null}

      <div className="workbench-tab-rail" role="tablist" aria-orientation="horizontal">
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
              className={`workbench-tab${selected ? ' workbench-tab--active' : ''}${
                disabled ? ' workbench-tab--disabled' : ''
              }`}
              aria-label={label}
              aria-selected={selected}
              aria-disabled={disabled}
              tabIndex={selected ? 0 : -1}
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
      </div>

      <div className="workbench-view-slot">
        <div
          className="workbench-view workbench-view--goal"
          data-active={activeTab === 'plan'}
          ref={goalSlotRef}
        />
        {layoutHost === 'root'
          ? mountedBrowserConversations(conversationId, preparedBrowserConversations).map((id) => (
            <div
              key={`mounted-browser-${id}`}
              className={`workbench-view workbench-view--browser${id === conversationId ? '' : ' workbench-view--prepared-browser'}`}
              data-active={id === conversationId ? activeTab === 'browser' : false}
              aria-hidden={id === conversationId ? undefined : true}
            >
              <BrowserView
                isZh={isZh}
                conversationId={id}
                session={id === conversationId ? browserSession : resolveBrowserSession(id)}
                onSessionChange={id === conversationId
                  ? setBrowserSession
                  : (next) => setBrowserSessionFor(id, next)}
                claimForeground={id === conversationId}
              />
            </div>
          ))
          : mountedBrowserConversations(conversationId, preparedBrowserConversations).map((id) => (
            <div
              key={`mounted-browser-${id}`}
              className={`workbench-view workbench-view--browser${id === conversationId ? '' : ' workbench-view--prepared-browser'}`}
              data-active={id === conversationId ? activeTab === 'browser' : false}
              aria-hidden={id === conversationId ? undefined : true}
            >
              <BrowserView
                isZh={isZh}
                conversationId={id}
                session={id === conversationId ? browserSession : resolveBrowserSession(id)}
                onSessionChange={id === conversationId
                  ? setBrowserSession
                  : (next) => setBrowserSessionFor(id, next)}
                claimForeground={id === conversationId}
              />
            </div>
          ))}
        <div
          className="workbench-view workbench-view--files"
          data-active={activeTab === 'files'}
        >
          <FilesView isZh={isZh} workspacePath={workspacePath} />
        </div>
        <div
          className="workbench-view workbench-view--documents"
          data-active={activeTab === 'documents'}
        >
          <DocumentView
            isZh={isZh}
            session={documentSession}
            onSessionChange={setDocumentSession}
            onBrowseFiles={() => setActiveTab('files')}
          />
        </div>
        <div
          className="workbench-view workbench-view--threads"
          data-active={activeTab === 'threads'}
        >
          <BackgroundThreadsView isZh={isZh} focusTaskId={focusThreadTaskId} />
        </div>
      </div>
    </aside>
  );
}

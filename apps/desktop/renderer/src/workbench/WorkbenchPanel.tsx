import { useEffect, useRef, type ReactElement } from 'react';
import { useWorkbench, type WorkbenchTabId } from './WorkbenchContext';
import { TerminalView } from './views/TerminalView';
import { BrowserView } from './views/BrowserView';
import { FilesView } from './views/FilesView';
import { DiffView } from './views/DiffView';
import {
  WORKBENCH_MIN_WIDTH,
  WORKBENCH_MAX_WIDTH,
  WORKBENCH_MAX_VW_RATIO,
  WORKBENCH_DEFAULT_WIDTH,
  MAIN_MIN_WIDTH,
} from './WorkbenchContext';

interface TabDef {
  readonly id: WorkbenchTabId;
  readonly labelZh: string;
  readonly labelEn: string;
  readonly icon: ReactElement;
}

const ICON_PROPS = {
  width: 18,
  height: 18,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

const TABS: readonly TabDef[] = [
  {
    id: 'goal',
    labelZh: '目标',
    labelEn: 'Goal',
    icon: (
      <svg {...ICON_PROPS}>
        <circle cx="12" cy="12" r="9" />
        <circle cx="12" cy="12" r="5" />
        <circle cx="12" cy="12" r="1.5" />
      </svg>
    ),
  },
  {
    id: 'terminal',
    labelZh: '终端',
    labelEn: 'Terminal',
    icon: (
      <svg {...ICON_PROPS}>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="m7 9 3 3-3 3" />
        <path d="M13 15h4" />
      </svg>
    ),
  },
  {
    id: 'browser',
    labelZh: '浏览器',
    labelEn: 'Browser',
    icon: (
      <svg {...ICON_PROPS}>
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
      <svg {...ICON_PROPS}>
        <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
      </svg>
    ),
  },
  {
    id: 'diff',
    labelZh: 'Diff',
    labelEn: 'Diff',
    icon: (
      <svg {...ICON_PROPS}>
        <path d="M12 3v6" />
        <path d="M9 6h6" />
        <path d="M12 15v6" />
        <path d="M9 18h6" />
        <path d="M5 9 3 12l2 3" />
        <path d="m19 9 2 3-2 3" />
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
    activeTab,
    setActiveTab,
    setWidth,
    hasGoalPlan,
    registerGoalSlot,
    sidebarAutoCollapsed,
    setSidebarAutoCollapsed,
  } = useWorkbench();

  const goalSlotRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    registerGoalSlot(goalSlotRef.current);
    return () => registerGoalSlot(null);
  }, [registerGoalSlot]);

  // 拖拽分隔线
  const draggingRef = useRef(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(width);

  const onPointerDown = (ev: React.PointerEvent<HTMLDivElement>) => {
    ev.preventDefault();
    draggingRef.current = true;
    startXRef.current = ev.clientX;
    startWidthRef.current = width;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';

    const computeUpper = () => {
      const vwLimit = Math.min(WORKBENCH_MAX_WIDTH, Math.floor(window.innerWidth * WORKBENCH_MAX_VW_RATIO));
      return Math.max(WORKBENCH_MIN_WIDTH, vwLimit);
    };

    const SIDEBAR_WIDTH = 264;
    const SIDEBAR_THRESHOLD = MAIN_MIN_WIDTH;
    const RESTORE_PAD = 24;

    const onMove = (e: PointerEvent) => {
      if (!draggingRef.current) return;
      const dx = startXRef.current - e.clientX;
      let next = startWidthRef.current + dx;
      const upper = computeUpper();
      if (next < WORKBENCH_MIN_WIDTH) next = WORKBENCH_MIN_WIDTH;
      if (next > upper) next = upper;
      // 直接改 CSS 变量，避免 re-render
      document.documentElement.style.setProperty('--za-workbench-width', `${next}px`);

      // 临界吸附：判断主区可见宽度
      const sidebarPresent = document.documentElement.dataset.sidebarCollapsed !== 'true';
      const mainAvailable = window.innerWidth - (sidebarPresent ? SIDEBAR_WIDTH : 0) - next;
      if (sidebarPresent && mainAvailable < SIDEBAR_THRESHOLD) {
        document.documentElement.dataset.sidebarCollapsed = 'true';
      } else if (!sidebarPresent && mainAvailable >= SIDEBAR_THRESHOLD + RESTORE_PAD + SIDEBAR_WIDTH) {
        // 反向：拖小让出 sidebar 空间后自动恢复
        document.documentElement.dataset.sidebarCollapsed = 'false';
      }
    };

    const onUp = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      const finalWidthStr = document.documentElement.style.getPropertyValue('--za-workbench-width');
      const finalWidth = parseInt(finalWidthStr, 10);
      if (Number.isFinite(finalWidth)) setWidth(finalWidth);
      const collapsed = document.documentElement.dataset.sidebarCollapsed === 'true';
      if (collapsed !== sidebarAutoCollapsed) setSidebarAutoCollapsed(collapsed);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
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
      className={`workbench-panel${open ? ' workbench-panel--open' : ''}`}
      aria-hidden={!open}
      style={{ width: open ? `${width}px` : 0 }}
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

      <div className="workbench-tab-rail" role="tablist" aria-orientation="vertical">
        {TABS.map((tab) => {
          const disabled = tab.id === 'goal' && !hasGoalPlan;
          const selected = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              className={`workbench-tab${selected ? ' workbench-tab--active' : ''}${
                disabled ? ' workbench-tab--disabled' : ''
              }`}
              aria-selected={selected}
              aria-disabled={disabled}
              tabIndex={selected ? 0 : -1}
              title={
                disabled
                  ? isZh ? '暂无 Goal' : 'No active goal'
                  : isZh ? tab.labelZh : tab.labelEn
              }
              onClick={() => {
                if (disabled) return;
                setActiveTab(tab.id);
              }}
            >
              <span className="workbench-tab-icon">{tab.icon}</span>
              <span className="workbench-tab-label">{isZh ? tab.labelZh : tab.labelEn}</span>
            </button>
          );
        })}
      </div>

      <div className="workbench-view-slot">
        <div
          className="workbench-view workbench-view--goal"
          data-active={activeTab === 'goal'}
          ref={goalSlotRef}
        />
        <div className="workbench-view" data-active={activeTab === 'terminal'}>
          <TerminalView isZh={isZh} />
        </div>
        <div
          className="workbench-view workbench-view--browser"
          data-active={activeTab === 'browser'}
        >
          <BrowserView isZh={isZh} />
        </div>
        <div className="workbench-view" data-active={activeTab === 'files'}>
          <FilesView isZh={isZh} workspacePath={workspacePath} />
        </div>
        <div
          className="workbench-view workbench-view--diff"
          data-active={activeTab === 'diff'}
        >
          <DiffView isZh={isZh} />
        </div>
      </div>
    </aside>
  );
}

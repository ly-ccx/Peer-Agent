import { usePointerResize } from '../app/hooks/usePointerResize';
import { isImeKey } from '../chat/state/compositionGuard';
import {
  useWorkbench,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_COLLAPSE_THRESHOLD,
} from './WorkbenchContext';

interface SidebarResizerProps {
  readonly isZh: boolean;
}

const ROOT = () => document.documentElement;

/**
 * 左侧栏拖拽分隔条（镜像右侧 workbench-resizer）。
 *
 * 交互：
 * - 拖拽时直接改 CSS 变量 --za-sidebar-current-width，避免每帧 re-render；松手才落 state。
 * - 阻尼区：宽度拖到 SIDEBAR_MIN_WIDTH 以下进入「预收起」提示（data-damping）。
 * - 松手判定：落点 < SIDEBAR_COLLAPSE_THRESHOLD → 自动收起；否则夹紧到 [MIN, MAX] 落定。
 * - 双击重置回 SIDEBAR_DEFAULT_WIDTH。
 * - 键盘箭头微调，Home/End 跳到 MAX/MIN。
 *
 * 见 peer-knowledge: design/product/left-sidebar-resizable-collapsible.md
 */
export function SidebarResizer({ isZh }: SidebarResizerProps) {
  const { sidebarWidth, setSidebarWidth, setSidebarOpen, setSidebarAutoCollapsed } = useWorkbench();
  const resize = usePointerResize();
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.isPrimary === false) return;
    const node = event.currentTarget, startX = event.clientX, startWidth = sidebarWidth;
    let next = startWidth;
    const started = resize.start(event, {
      onMove: clientX => {
        next = Math.max(SIDEBAR_COLLAPSE_THRESHOLD - 24, Math.min(SIDEBAR_MAX_WIDTH, startWidth + clientX - startX));
        ROOT().style.setProperty('--za-sidebar-current-width', `${next}px`);
        node.toggleAttribute('data-damping', next < SIDEBAR_MIN_WIDTH);
      },
      onEnd: committed => {
        delete ROOT().dataset.sidebarResizing; node.removeAttribute('data-active'); node.removeAttribute('data-damping');
        if (!committed || next < SIDEBAR_COLLAPSE_THRESHOLD) {
          ROOT().style.setProperty('--za-sidebar-current-width', `${startWidth}px`);
          if (committed) setSidebarOpen(false);
        } else {
          next = Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, next));
          ROOT().style.setProperty('--za-sidebar-current-width', `${next}px`);
          setSidebarWidth(next); setSidebarAutoCollapsed(false);
        }
      },
    });
    if (started) { ROOT().dataset.sidebarResizing = 'true'; node.setAttribute('data-active', 'true'); }
  };

  const onDoubleClick = () => {
    resize.cancel(); setSidebarWidth(SIDEBAR_DEFAULT_WIDTH);
    setSidebarAutoCollapsed(false);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (isImeKey(e.nativeEvent)) return;
    if (['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(e.key)) resize.cancel();
    const STEP = 16;
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      setSidebarWidth(sidebarWidth + STEP);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      setSidebarWidth(sidebarWidth - STEP);
    } else if (e.key === 'Home') {
      e.preventDefault();
      setSidebarWidth(SIDEBAR_MIN_WIDTH);
    } else if (e.key === 'End') {
      e.preventDefault();
      setSidebarWidth(SIDEBAR_MAX_WIDTH);
    }
  };

  return (
    <div
      className="sidebar-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-valuemin={SIDEBAR_MIN_WIDTH} aria-valuemax={SIDEBAR_MAX_WIDTH} aria-valuenow={sidebarWidth}
      aria-label={isZh ? '拖拽调整侧边栏宽度' : 'Resize sidebar'}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
      onKeyDown={onKeyDown}
    />
  );
}

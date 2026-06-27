import { useRef } from 'react';
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
  const draggingRef = useRef(false);
  const elRef = useRef<HTMLDivElement | null>(null);

  const onPointerDown = (ev: React.PointerEvent<HTMLDivElement>) => {
    ev.preventDefault();
    draggingRef.current = true;
    const startX = ev.clientX;
    const startWidth = sidebarWidth;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    ROOT().dataset.sidebarResizing = 'true';
    elRef.current?.setAttribute('data-active', 'true');

    // rAF 合并写：一帧内的多次 pointermove 只在下一帧 flush 一次，
    // 避免高刷屏/高轮询鼠标下同一帧多次写 CSS 变量触发多次 reflow。
    let rafId = 0;
    let latestX = startX;

    // 用最新指针位置计算宽度并落到 CSS 变量（夹紧阈值/阻尼逻辑保持不变）。
    const flush = () => {
      rafId = 0;
      const dx = latestX - startX;
      // 允许临时拖到 MIN 以下（直到收起阈值），用于阻尼区与收起判定。
      let next = startWidth + dx;
      if (next < SIDEBAR_COLLAPSE_THRESHOLD - 24) next = SIDEBAR_COLLAPSE_THRESHOLD - 24;
      if (next > SIDEBAR_MAX_WIDTH) next = SIDEBAR_MAX_WIDTH;
      // 直接改 CSS 变量，避免 re-render
      ROOT().style.setProperty('--za-sidebar-current-width', `${next}px`);
      // 阻尼区视觉提示：低于最小展开宽度即将触发收起
      if (next < SIDEBAR_MIN_WIDTH) {
        elRef.current?.setAttribute('data-damping', 'true');
      } else {
        elRef.current?.removeAttribute('data-damping');
      }
    };

    const onMove = (e: PointerEvent) => {
      if (!draggingRef.current) return;
      // 仅记录最新位置，按帧调度 flush（每帧最多写一次）。
      latestX = e.clientX;
      if (rafId === 0) rafId = requestAnimationFrame(flush);
    };

    const onUp = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      // 取消挂起帧并同步补写最终宽度，保证下方从 CSS 变量读取 finalWidth 时已是最新值。
      if (rafId !== 0) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
      flush();
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      delete ROOT().dataset.sidebarResizing;
      elRef.current?.removeAttribute('data-active');
      elRef.current?.removeAttribute('data-damping');

      const finalStr = ROOT().style.getPropertyValue('--za-sidebar-current-width');
      const finalWidth = parseInt(finalStr, 10);

      if (Number.isFinite(finalWidth) && finalWidth < SIDEBAR_COLLAPSE_THRESHOLD) {
        // 拖到阈值以下：视为用户主动收起。宽度回落到上次落定值（不写入超窄宽度），
        // 这样下次展开仍是合理宽度。
        ROOT().style.setProperty('--za-sidebar-current-width', `${sidebarWidth}px`);
        setSidebarOpen(false);
      } else if (Number.isFinite(finalWidth)) {
        // 正常落定：夹紧到 [MIN, MAX] 并持久化（< MIN 但 ≥ 阈值则吸附回 MIN）。
        const clamped = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, finalWidth));
        ROOT().style.setProperty('--za-sidebar-current-width', `${clamped}px`);
        setSidebarWidth(clamped);
        // 拖拽落定属于用户主动调宽，清除可能存在的自动收起标记。
        setSidebarAutoCollapsed(false);
      }

      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const onDoubleClick = () => {
    setSidebarWidth(SIDEBAR_DEFAULT_WIDTH);
    setSidebarAutoCollapsed(false);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
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
      ref={elRef}
      className="sidebar-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label={isZh ? '拖拽调整侧边栏宽度' : 'Resize sidebar'}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
      onKeyDown={onKeyDown}
    />
  );
}

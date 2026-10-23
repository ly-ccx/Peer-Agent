import { useRef } from 'react';
import { DRAWER_MAX_WIDTH, DRAWER_MIN_WIDTH, clampDrawerWidth } from '../state/drawerState';

interface BotDrawerResizerProps {
  /** 当前落定宽度；undefined 表示用户从未拖过，用 CSS 默认值。 */
  readonly width: number | undefined;
  readonly isZh: boolean;
  /** 拖拽落定宽度（已夹紧）。 */
  readonly onResize: (width: number) => void;
}

/** 与 .bot-drawer-dock 和 .bot-drawer-panel 的 --pa-drawer-width 默认值保持一致。 */
const CSS_DEFAULT_WIDTH = 414;

/**
 * 设置抽屉与中间会话区之间的拖拽分隔条。
 *
 * 位置要求：必须渲染在 dock **外面**、与 dock 同级。dock 有 overflow:hidden
 * （宽度过渡时要裁掉 414px 宽的 body），放在里面任何负偏移都会被裁掉，
 * 表现为「看不见也拖不到」。外层 .bot-drawer-dock-frame 负责给这里留定位基准。
 *
 * 交互：
 * - 抽屉在右、会话区在左，所以指针「向左」变宽、「向右」变窄（dx 取反）。
 * - 拖拽中直接改 dock 的 CSS 变量，避免每帧 re-render；松手才落 state 并持久化。
 * - 宽度夹紧在 [DRAWER_MIN_WIDTH, DRAWER_MAX_WIDTH]，保证中间会话区不被压没。
 * - 双击重置回默认宽度；键盘左右微调，Home/End 跳到最小/最大。
 */
export function BotDrawerResizer({ width, isZh, onResize }: BotDrawerResizerProps) {
  const elRef = useRef<HTMLDivElement | null>(null);

  const currentWidth = () => width ?? CSS_DEFAULT_WIDTH;

  /** dock 与本组件同为 frame 的子元素，从父元素里找 dock。 */
  const findDock = () =>
    elRef.current?.parentElement?.querySelector<HTMLElement>('.bot-drawer-dock') ?? null;

  const applyWidth = (next: number) => {
    findDock()?.style.setProperty('--pa-drawer-width', `${next}px`);
  };

  const setResizing = (resizing: boolean) => {
    const target = findDock();
    if (!target) return;
    if (resizing) target.setAttribute('data-resizing', 'true');
    else target.removeAttribute('data-resizing');
  };

  const onPointerDown = (ev: React.PointerEvent<HTMLDivElement>) => {
    ev.preventDefault();
    const startX = ev.clientX;
    const startWidth = currentWidth();
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    elRef.current?.setAttribute('data-active', 'true');
    setResizing(true);

    let latestX = startX;
    let rafId = 0;

    const flush = () => {
      rafId = 0;
      // 抽屉贴右缘：指针左移（dx<0）应让面板变宽，故取反。
      applyWidth(clampDrawerWidth(startWidth - (latestX - startX)));
    };

    const onMove = (e: PointerEvent) => {
      latestX = e.clientX;
      if (rafId === 0) rafId = requestAnimationFrame(flush);
    };

    const onUp = () => {
      if (rafId !== 0) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
      flush();
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      elRef.current?.removeAttribute('data-active');
      // 先落 state（写入持久化宽度），再恢复过渡，避免松手瞬间再次动画。
      onResize(clampDrawerWidth(startWidth - (latestX - startX)));
      setResizing(false);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const onDoubleClick = () => {
    applyWidth(CSS_DEFAULT_WIDTH);
    onResize(CSS_DEFAULT_WIDTH);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const STEP = 16;
    // 方向键按「屏幕方向」理解：左键让面板变宽。
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      onResize(clampDrawerWidth(currentWidth() + STEP));
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      onResize(clampDrawerWidth(currentWidth() - STEP));
    } else if (e.key === 'Home') {
      e.preventDefault();
      onResize(DRAWER_MIN_WIDTH);
    } else if (e.key === 'End') {
      e.preventDefault();
      onResize(DRAWER_MAX_WIDTH);
    }
  };

  return (
    <div
      ref={elRef}
      className="bot-drawer-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label={isZh ? '拖拽调整设置区宽度' : 'Resize settings panel'}
      aria-valuemin={DRAWER_MIN_WIDTH}
      aria-valuemax={DRAWER_MAX_WIDTH}
      aria-valuenow={currentWidth()}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
      onKeyDown={onKeyDown}
    />
  );
}

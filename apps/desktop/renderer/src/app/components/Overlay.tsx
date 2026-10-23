import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { useFocusScope } from '../hooks/useFocusScope';
import { positionAnchoredOverlay } from './anchoredOverlay';
import { createPortal } from 'react-dom';
import { interactionLayers } from './interactionLayers';
import { InteractionLayerContext, useInteractionLayer } from '../hooks/useInteractionLayer';
import { overlayCloseTarget } from './overlayCloseTarget';

/**
 * Overlay —— 统一浮层基座（默认模态；anchor 为非模态，均仅负责表达）。
 *
 * 设计语言依据：peer-knowledge/knowledge/specifications/peer-product-experience-standard.md、motion-system.md 与 transition-system.md。
 * 所有模态 / 浮层必须经由本组件挂载，避免每处手写 backdrop 而漏掉过渡动效。
 *
 * 统一职责：
 *   - backdrop 冷调遮罩 + 淡入（za-content-reveal）/ 退场淡出（za-fade-out）。
 *   - 面板入场动效（za-panel-in）/ 退场下移淡出（za-slide-down-out），位移 < 12px；
 *     prefers-reduced-motion 由 tokens.css 全局兜底降级。
 *   - 退场编排：ESC / 点击遮罩 / 调用方关闭统一先播退场动画，动画结束后才真正 onClose 卸载。
 *   - 交互：ESC 关闭、点击遮罩关闭、面板内点击不冒泡。
 *   - 可达性：role="dialog" + aria-modal。
 *   - 全局挂载：portal 到 document.body，避免被页面容器 transform / overflow 限制。
 *
 * 本组件只负责表达与交互编排，不持有任何能力真相。
 */
export function Overlay({
  onClose,
  closeOnBackdrop = true,
  ariaLabel,
  panelClassName,
  backdropClassName,
  anchor,
  id,
  onEscape,
  onRequestClose,
  closeTarget,
  restoreFocusRef,
  children,
}: {
  /** Supplying an anchor selects the non-modal, viewport-clamped variant. */
  readonly anchor?: HTMLElement;
  readonly restoreFocusRef?: RefObject<HTMLElement | null>;
  readonly id?: string;
  /** Return true when an inner confirmation consumed Escape. */
  readonly onEscape?: () => boolean;
  /** Return false to retain the live layer while its editor resolves unsaved work. */
  readonly onRequestClose?: () => boolean;
  /** Optional destination for an action that continues in another visible control. */
  readonly closeTarget?: () => HTMLElement | null;
  readonly onClose?: () => void;
  readonly closeOnBackdrop?: boolean;
  readonly ariaLabel?: string;
  readonly panelClassName?: string;
  /**
   * 附加到 backdrop 的修饰类，仅用于调整遮罩观感（如图片预览的重遮罩）。
   * 入场 / 退场动效仍由基座 .pa-overlay-backdrop 统一提供，不得在修饰类里改动效。
   */
  readonly backdropClassName?: string;
  /**
   * children 可为普通 ReactNode，或 render-prop。后者会收到 { requestClose }，
   * 使浮层内部的按钮（如「稍后」「更新」）也能复用统一退场动画，而非直接卸载。
   */
  readonly children: ReactNode | ((api: { readonly requestClose: () => void }) => ReactNode);
}) {
  const [closing, setClosing] = useState(false);
  const [closingStyle, setClosingStyle] = useState<CSSProperties>();
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const requestGuard = useRef(onRequestClose); requestGuard.current = onRequestClose;
  const closeRef = useRef(onClose); closeRef.current = onClose;
  const closingRef = useRef(false), finished = useRef(false);
  const acceptedClose = useRef<(() => void) | null>(null);
  const anchorRef = useRef<HTMLElement | null>(anchor ?? null); anchorRef.current = anchor ?? null;
  const layer = useInteractionLayer(true, { roots: [panelRef], trigger: restoreFocusRef ?? (anchor ? anchorRef : undefined), modal: !anchor, closeOnTriggerRemoval: Boolean(anchor), outside: closeOnBackdrop,
    onClose: onClose ? () => requestClose() : undefined, onEscape });
  useFocusScope(panelRef, !anchor, { trap: true, restoreFocus: false, ownsScope: () => interactionLayers.topInteractive() === interactionLayers.layerFor(panelRef.current) });
  const [placement, setPlacement] = useState<CSSProperties>({ visibility: 'hidden' });

  useLayoutEffect(() => {
    if (!closing || !closeTarget) return;
    const panel = panelRef.current, target = closeTarget();
    if (panel && target?.isConnected) setClosingStyle(overlayCloseTarget(panel.getBoundingClientRect(), target.getBoundingClientRect()));
  }, [closing, closeTarget]);

  useLayoutEffect(() => {
    if (!anchor) return;
    const panel = panelRef.current;
    if (!panel) return;
    const place = () => setPlacement(positionAnchoredOverlay(
      anchor.getBoundingClientRect(),
      { width: panel.offsetWidth, height: panel.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight },
    ));
    place();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    observer?.observe(panel);
    observer?.observe(anchor);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    if (!panel.contains(document.activeElement)) panel.focus({ preventScroll: true });
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);

    };
  }, [anchor]);
  // 退场动画兜底定时器：防止 animationend 事件因故丢失导致浮层卡死不卸载。
  const fallbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 请求关闭：先进入退场态播动画，真正的 onClose 卸载交由 finishClose 收尾。
  const requestClose = useCallback(() => {
    if (!closeRef.current || closingRef.current || requestGuard.current?.() === false) return;
    acceptedClose.current = closeRef.current; closingRef.current = true; setClosing(true);
  }, []);

  // 退场动画结束（或兜底超时）后，执行调用方传入的真正卸载。
  const finishClose = useCallback(() => {
    if (finished.current) return;
    finished.current = true;
    if (fallbackTimer.current) {
      clearTimeout(fallbackTimer.current);
      fallbackTimer.current = null;
    }
    (acceptedClose.current ?? closeRef.current)?.();
  }, []);

  // Start the duration fallback after the native animation is ready. Under
  // renderer load its pending start may outlast the old duration-only timer.
  useEffect(() => {
    if (!closing) return undefined;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { finishClose(); return undefined; }
    let current = true;
    const animations = panelRef.current?.getAnimations?.() ?? [];
    if (!animations.length) { finishClose(); return; }
    // A broken/never-started animation must still release the overlay.
    fallbackTimer.current = setTimeout(finishClose, 2000);
    void Promise.allSettled(animations.map(animation => animation.ready)).then(() => {
      if (!current) return;
      const remaining = animations.map(animation => {
        const end = animation.effect?.getComputedTiming().endTime;
        const time = typeof animation.currentTime === 'number' ? animation.currentTime : 0;
        return typeof end === 'number' && Number.isFinite(end)
          ? Math.max(0, end - time) / (Math.abs(animation.playbackRate) || 1) : 0;
      });
      if (fallbackTimer.current) clearTimeout(fallbackTimer.current);
      fallbackTimer.current = setTimeout(finishClose, Math.max(240, ...remaining.map(duration => duration + 60)));
    });
    return () => {
      current = false;
      if (fallbackTimer.current) {
        clearTimeout(fallbackTimer.current);
        fallbackTimer.current = null;
      }
    };
  }, [closing, closingStyle, finishClose]);

  useEffect(() => {
    if (!closing) return;
    const panel = panelRef.current;
    const cancel = (event: AnimationEvent) => { if (event.target === panel) finishClose(); };
    const preference = matchMedia('(prefers-reduced-motion: reduce)');
    const reduced = () => { if (preference.matches) finishClose(); };
    preference.addEventListener?.('change', reduced);
    panel?.addEventListener('animationcancel', cancel);
    return () => { panel?.removeEventListener('animationcancel', cancel); preference.removeEventListener?.('change', reduced); };
  }, [closing, finishClose]);

  const backdropBase = closing ? 'pa-overlay-backdrop is-closing' : 'pa-overlay-backdrop';
  const panelBase = closing ? `pa-overlay-panel is-closing${closingStyle ? ' is-minimizing' : ''}` : 'pa-overlay-panel';

  const overlay = (
    <div
      ref={overlayRef}
      data-peer-overlay="true"
      className={`${backdropBase}${anchor ? ' pa-overlay--anchored' : ''}${backdropClassName ? ` ${backdropClassName}` : ''}`}
      role="presentation"
      onClickCapture={closing ? event => { event.preventDefault(); event.stopPropagation(); } : undefined}
      onKeyDownCapture={closing ? event => { if (event.key !== 'Tab' && event.key !== 'Escape') { event.preventDefault(); event.stopPropagation(); } } : undefined}
    >
      <div
        className={panelClassName ? `${panelBase} ${panelClassName}` : panelBase}
        ref={panelRef}
        id={id}
        style={closingStyle ?? (anchor ? placement : undefined)}
        tabIndex={-1}
        role="dialog"
        aria-modal={anchor ? undefined : true}
        aria-label={ariaLabel}
        onClick={(event) => event.stopPropagation()}
        onAnimationEnd={closing ? event => { if (event.target === event.currentTarget) finishClose(); } : undefined}
      >
        <InteractionLayerContext.Provider value={layer}>{typeof children === 'function' ? children({ requestClose }) : children}</InteractionLayerContext.Provider>
      </div>
    </div>
  );

  if (typeof document === 'undefined') {
    return overlay;
  }

  return createPortal(overlay, document.body);
}

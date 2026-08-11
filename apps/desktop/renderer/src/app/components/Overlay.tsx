import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { isTopmostOverlay, OVERLAY_SELECTOR } from './overlayStack';

/**
 * Overlay —— 统一的模态浮层基座（表达层）。
 *
 * 设计语言依据：docs/architecture/14-product-design-language.md §11.3「弹出层动效准入」。
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
  children,
}: {
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
  const overlayRef = useRef<HTMLDivElement | null>(null);
  // 退场动画兜底定时器：防止 animationend 事件因故丢失导致浮层卡死不卸载。
  const fallbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 请求关闭：先进入退场态播动画，真正的 onClose 卸载交由 finishClose 收尾。
  const requestClose = useCallback(() => {
    if (!onClose) return;
    setClosing(true);
  }, [onClose]);

  // 退场动画结束（或兜底超时）后，执行调用方传入的真正卸载。
  const finishClose = useCallback(() => {
    if (fallbackTimer.current) {
      clearTimeout(fallbackTimer.current);
      fallbackTimer.current = null;
    }
    onClose?.();
  }, [onClose]);

  useEffect(() => {
    if (!onClose) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const overlays = Array.from(document.querySelectorAll(OVERLAY_SELECTOR));
      if (!isTopmostOverlay(overlayRef.current, overlays)) return;
      event.stopImmediatePropagation();
      requestClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, requestClose]);

  // 进入退场态后启动兜底定时器；时长略大于退场动画（--za-motion-fast=120ms）。
  useEffect(() => {
    if (!closing) return undefined;
    fallbackTimer.current = setTimeout(finishClose, 240);
    return () => {
      if (fallbackTimer.current) {
        clearTimeout(fallbackTimer.current);
        fallbackTimer.current = null;
      }
    };
  }, [closing, finishClose]);

  const backdropBase = closing ? 'pa-overlay-backdrop is-closing' : 'pa-overlay-backdrop';
  const panelBase = closing ? 'pa-overlay-panel is-closing' : 'pa-overlay-panel';

  const overlay = (
    <div
      ref={overlayRef}
      data-peer-overlay="true"
      className={backdropClassName ? `${backdropBase} ${backdropClassName}` : backdropBase}
      role="presentation"
      onClick={closeOnBackdrop && onClose ? requestClose : undefined}
    >
      <div
        className={panelClassName ? `${panelBase} ${panelClassName}` : panelBase}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        onClick={(event) => event.stopPropagation()}
        onAnimationEnd={closing ? finishClose : undefined}
      >
        {typeof children === 'function' ? children({ requestClose }) : children}
      </div>
    </div>
  );

  if (typeof document === 'undefined') {
    return overlay;
  }

  return createPortal(overlay, document.body);
}

import { useEffect, type ReactNode } from 'react';

/**
 * Overlay —— 统一的模态浮层基座（表达层）。
 *
 * 设计语言依据：docs/architecture/14-product-design-language.md §11.3「弹出层动效准入」。
 * 所有模态 / 浮层必须经由本组件挂载，避免每处手写 backdrop 而漏掉过渡动效。
 *
 * 统一职责：
 *   - backdrop 冷调遮罩 + 淡入（za-content-reveal）。
 *   - 面板入场动效（za-panel-in），位移 < 12px；prefers-reduced-motion 由 tokens.css 全局兜底降级。
 *   - 交互：ESC 关闭、点击遮罩关闭、面板内点击不冒泡。
 *   - 可达性：role="dialog" + aria-modal。
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
  readonly children: ReactNode;
}) {
  useEffect(() => {
    if (!onClose) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className={backdropClassName ? `pa-overlay-backdrop ${backdropClassName}` : 'pa-overlay-backdrop'}
      role="presentation"
      onClick={closeOnBackdrop && onClose ? onClose : undefined}
    >
      <div
        className={panelClassName ? `pa-overlay-panel ${panelClassName}` : 'pa-overlay-panel'}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        onClick={(event) => event.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

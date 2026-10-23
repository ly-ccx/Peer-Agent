import { useInteractionLayer } from '../hooks/useInteractionLayer';
import {
  cloneElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

type TooltipPlacement = 'top' | 'bottom';

/**
 * 自绘 Tooltip：替换浏览器原生 title 气泡，使 hover 提示成为受控样式浮层。
 *
 * - 通过 portal 挂到 body，避免被状态栏 overflow / stacking context 裁剪。
 * - hover 与键盘 focus 均可触发，role="tooltip" + aria-describedby 保留无障碍语义。
 * - 支持多行内容（lines 数组或任意 ReactNode）。
 * - 定位随触发元素在视口中的位置自适应（默认在上方，空间不足翻到下方）。
 */
export function Tooltip({
  children,
  content,
  lines,
  placement = 'top',
  openDelayMs = 120,
}: {
  readonly children: ReactElement;
  readonly content?: ReactNode;
  readonly lines?: readonly string[];
  readonly placement?: TooltipPlacement;
  readonly openDelayMs?: number;
}): ReactElement {
  const tooltipId = useId();
  const anchorRef = useRef<HTMLElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intent = useRef({ anchor: false, tip: false, focus: false, dismissed: false });
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number; place: TooltipPlacement }>({
    top: 0,
    left: 0,
    place: placement,
  });

  const hasContent = Boolean(content) || (lines != null && lines.length > 0);

  const clearOpenTimer = useCallback(() => {
    if (openTimer.current != null) {
      clearTimeout(openTimer.current);
      openTimer.current = null;
    }
  }, []);

  const clearCloseTimer = useCallback(() => {
    if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }, []);
  const hide = useCallback(() => {
    clearOpenTimer(); clearCloseTimer(); setOpen(false);
  }, [clearOpenTimer, clearCloseTimer]);
  const show = useCallback(() => {
    clearCloseTimer();
    if (!hasContent || intent.current.dismissed) return;
    clearOpenTimer();
    openTimer.current = setTimeout(() => {
      if (!intent.current.dismissed && (intent.current.anchor || intent.current.focus || intent.current.tip)) setOpen(true);
    }, Math.max(0, openDelayMs));
  }, [clearOpenTimer, clearCloseTimer, hasContent, openDelayMs]);
  const leave = useCallback(() => {
    clearOpenTimer(); clearCloseTimer();
    if (intent.current.anchor || intent.current.tip || intent.current.focus) return;
    intent.current.dismissed = false;
    // Bridge the measured anchor/tip gap without making the content disappear under the pointer.
    closeTimer.current = setTimeout(hide, 100);
  }, [clearOpenTimer, clearCloseTimer, hide]);
  useEffect(() => () => { clearOpenTimer(); clearCloseTimer(); }, [clearOpenTimer, clearCloseTimer]);
  useInteractionLayer(open && hasContent, { roots: [tooltipRef], trigger: anchorRef, passive: true, restoreFocus: false, closeOnTriggerRemoval: true,
    onClose: () => { intent.current.dismissed = true; hide(); } });

  // 按锚点与浮层实际尺寸计算位置；视口上方空间不足时翻到下方。
  // 抽成 updatePosition，供打开后 layout 与滚动/resize 共用：
  // 聊天流式自动滚动会冒泡 window scroll，若直接 hide 会关掉仍在 hover 的气泡。
  const updatePosition = useCallback(() => {
    const anchor = anchorRef.current;
    const tip = tooltipRef.current;
    if (!anchor || !tip) return;
    if (!anchor.isConnected) { hide(); return; }
    const a = anchor.getBoundingClientRect();
    const t = tip.getBoundingClientRect();
    const margin = 8;
    let place: TooltipPlacement = placement;
    if (placement === 'top' && a.top - t.height - margin < 0) {
      place = 'bottom';
    } else if (placement === 'bottom' && a.bottom + t.height + margin > window.innerHeight) {
      place = 'top';
    }
    const top = place === 'top' ? a.top - t.height - margin : a.bottom + margin;
    let left = a.left + a.width / 2 - t.width / 2;
    left = Math.max(margin, Math.min(left, window.innerWidth - t.width - margin));
    setCoords({ top, left, place });
  }, [placement, hide]);

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
  }, [open, placement, content, lines, updatePosition]);

  useEffect(() => {
    if (!open) return;
    const onScrollOrResize = () => updatePosition();
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);
    return () => {
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
    };
  }, [open, updatePosition]);

  const anchor = cloneElement(children, {
    ref: (node: HTMLElement | null) => {
      anchorRef.current = node;
      const { ref } = children as unknown as { ref?: unknown };
      if (typeof ref === 'function') (ref as (n: HTMLElement | null) => void)(node);
      else if (ref && typeof ref === 'object') {
        (ref as { current: HTMLElement | null }).current = node;
      }
    },
    'aria-describedby': [(children.props as { 'aria-describedby'?: string })['aria-describedby'], open && hasContent ? tooltipId : ''].filter(Boolean).join(' ') || undefined,
    onMouseEnter: (e: unknown) => {
      intent.current.anchor = true; show();
      (children.props as { onMouseEnter?: (e: unknown) => void }).onMouseEnter?.(e);
    },
    onMouseLeave: (e: unknown) => {
      intent.current.anchor = false; leave();
      (children.props as { onMouseLeave?: (e: unknown) => void }).onMouseLeave?.(e);
    },
    onFocus: (e: unknown) => {
      intent.current.focus = true; show();
      (children.props as { onFocus?: (e: unknown) => void }).onFocus?.(e);
    },
    onBlur: (e: unknown) => {
      intent.current.focus = false; leave();
      (children.props as { onBlur?: (e: unknown) => void }).onBlur?.(e);
    },
  } as Record<string, unknown>);

  const overlay =
    open && hasContent
      ? createPortal(
          <div
            ref={tooltipRef}
            id={tooltipId}
            role="tooltip"
            onMouseEnter={() => { intent.current.tip = true; clearCloseTimer(); }}
            onMouseLeave={() => { intent.current.tip = false; leave(); }}
            className={`app-tooltip app-tooltip--${coords.place}`}
            style={{ top: coords.top, left: coords.left } as CSSProperties}
          >
            {content != null
              ? content
              : lines?.map((line, i) => (
                  <span key={i} className="app-tooltip__line">
                    {line}
                  </span>
                ))}
            <span className="app-tooltip__arrow" aria-hidden />
          </div>,
          document.body,
        )
      : null;

  return (
    <>
      {anchor}
      {overlay}
    </>
  );
}

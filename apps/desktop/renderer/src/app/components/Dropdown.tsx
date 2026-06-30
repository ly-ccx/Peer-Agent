import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export interface DropdownOption {
  readonly value: string;
  readonly label: string;
  readonly tone?: 'danger';
}

interface MenuCoords {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly placement: 'down' | 'up';
}

// 暗色自定义下拉，替代原生 <select>(原生在 macOS 会套系统皮，与暗色设计语言割裂)。
// 受控组件:value/onChange。交互复用聊天区 slash-command-menu 的 listbox 模式:
// role=listbox/option、键盘可达(↑↓ 移动、Enter/Space 选择、Esc 关闭)、点击外部关闭。
//
// 菜单通过 createPortal 投影到 document.body，并以 position:fixed 按触发器位置定位。
// 这样菜单彻底脱离任何祖先滚动容器(如 .mcp-modal-body)的可滚动溢出计算，
// 展开时不会把容器撑高、冒出滚动条；同时按视口可用空间自适应向上/向下展开。
export function Dropdown({
  value,
  options,
  onChange,
  disabled = false,
  placeholder,
  ariaLabel,
  className,
  title,
  menuPlacement = 'down',
}: {
  readonly value: string;
  readonly options: readonly DropdownOption[];
  readonly onChange: (value: string) => void;
  readonly disabled?: boolean;
  readonly placeholder?: string;
  readonly ariaLabel?: string;
  readonly className?: string;
  readonly title?: string;
  readonly menuPlacement?: 'down' | 'up';
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [coords, setCoords] = useState<MenuCoords | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const listId = useId();

  const selected = options.find((o) => o.value === value);
  const triggerLabel = selected?.label ?? placeholder ?? value;

  // 依据触发器在视口中的位置计算 fixed 菜单坐标，并按可用空间自适应上下方向。
  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const gap = 4;
    const viewportH = window.innerHeight;
    const menuH = menuRef.current?.offsetHeight ?? 0;
    const spaceBelow = viewportH - rect.bottom - gap;
    const spaceAbove = rect.top - gap;
    let placement: 'down' | 'up' = menuPlacement;
    if (placement === 'down' && spaceBelow < menuH && spaceAbove > spaceBelow) {
      placement = 'up';
    } else if (placement === 'up' && spaceAbove < menuH && spaceBelow > spaceAbove) {
      placement = 'down';
    }
    const top = placement === 'down' ? rect.bottom + gap : Math.max(gap, rect.top - menuH - gap);
    setCoords({ left: rect.left, top, width: rect.width, placement });
  }, [menuPlacement]);

  // 点击/触摸组件外部时关闭。菜单已被 portal 移出 root，需同时排除菜单自身。
  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      const inRoot = rootRef.current?.contains(target) ?? false;
      const inMenu = menuRef.current?.contains(target) ?? false;
      if (!inRoot && !inMenu) {
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  // 打开时把高亮对齐到当前选中项(无选中则首项)。
  useEffect(() => {
    if (!open) return;
    const idx = options.findIndex((o) => o.value === value);
    setActiveIndex(idx >= 0 ? idx : 0);
  }, [open, options, value]);

  // 打开后在 paint 前测量菜单高度并定位，避免首帧闪烁；关闭时清空坐标。
  useLayoutEffect(() => {
    if (!open) {
      setCoords(null);
      return;
    }
    updatePosition();
  }, [open, updatePosition]);

  // 打开期间，祖先滚动或窗口尺寸变化时跟随重定位(scroll 用 capture 以捕获内部滚动容器)。
  useEffect(() => {
    if (!open) return undefined;
    const onReflow = () => updatePosition();
    window.addEventListener('scroll', onReflow, true);
    window.addEventListener('resize', onReflow);
    return () => {
      window.removeEventListener('scroll', onReflow, true);
      window.removeEventListener('resize', onReflow);
    };
  }, [open, updatePosition]);

  const commit = useCallback(
    (index: number) => {
      const opt = options[index];
      if (opt) onChange(opt.value);
      setOpen(false);
    },
    [options, onChange],
  );

  const onTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (!open) {
      if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        setOpen(true);
      }
      return;
    }
    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        setOpen(false);
        break;
      case 'ArrowDown':
        event.preventDefault();
        setActiveIndex((i) => Math.min(i + 1, options.length - 1));
        break;
      case 'ArrowUp':
        event.preventDefault();
        setActiveIndex((i) => Math.max(i - 1, 0));
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        commit(activeIndex);
        break;
      default:
        break;
    }
  };

  const rootClassName = [
    'pa-dropdown',
    menuPlacement === 'up' ? 'pa-dropdown-up' : '',
    selected?.tone === 'danger' ? 'pa-dropdown-danger' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  // fixed 菜单样式：坐标就绪前先隐藏(仍挂载于 DOM 以供测量)，避免左上角闪现。
  // 宽度经 CSS 自定义属性下发，由样式表决定是否贴合触发器宽度(默认下拉)或自适应内容(composer)。
  const menuStyle: CSSProperties = coords
    ? ({
        position: 'fixed',
        left: coords.left,
        top: coords.top,
        '--pa-dropdown-menu-width': `${coords.width}px`,
      } as CSSProperties)
    : { position: 'fixed', left: 0, top: 0, visibility: 'hidden' };

  // 菜单已被 portal 移出 root，需把消费方 className 透传到菜单上，
  // 使原先依赖祖先关系的样式(如 .composer-dropdown .pa-dropdown-menu)改写为复合选择器后仍生效。
  const menu = open
    ? createPortal(
        <div
          ref={menuRef}
          className={`pa-dropdown-menu ${className ?? ''} ${coords?.placement === 'up' ? 'is-up' : 'is-down'}`.trim()}
          role="listbox"
          id={listId}
          aria-label={ariaLabel}
          style={menuStyle}
        >
          {options.map((opt, index) => (
            <button
              key={opt.value}
              type="button"
              role="option"
              aria-selected={opt.value === value}
              className={`pa-dropdown-item ${index === activeIndex ? 'active' : ''} ${opt.value === value ? 'selected' : ''} ${opt.tone === 'danger' ? 'danger' : ''}`}
              onMouseEnter={() => setActiveIndex(index)}
              onMouseDown={(event) => {
                event.preventDefault();
                commit(index);
              }}
            >
              <span className="pa-dropdown-check" aria-hidden>
                {opt.value === value ? '✓' : ''}
              </span>
              <span className="pa-dropdown-item-label">{opt.label}</span>
            </button>
          ))}
        </div>,
        document.body,
      )
    : null;

  return (
    <div className={rootClassName} ref={rootRef} title={title}>
      <button
        ref={triggerRef}
        type="button"
        className={`pa-dropdown-trigger ${open ? 'open' : ''}`}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={ariaLabel}
        onClick={() => !disabled && setOpen((v) => !v)}
        onKeyDown={onTriggerKeyDown}
      >
        <span className="pa-dropdown-value">{triggerLabel}</span>
        <svg
          className="pa-dropdown-caret"
          aria-hidden
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {menu}
    </div>
  );
}

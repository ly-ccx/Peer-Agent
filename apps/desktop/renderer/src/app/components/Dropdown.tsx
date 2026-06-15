import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';

export interface DropdownOption {
  readonly value: string;
  readonly label: string;
}

// 暗色自定义下拉，替代原生 <select>(原生在 macOS 会套系统皮，与暗色设计语言割裂)。
// 受控组件:value/onChange。交互复用聊天区 slash-command-menu 的 listbox 模式:
// role=listbox/option、键盘可达(↑↓ 移动、Enter/Space 选择、Esc 关闭)、点击外部关闭。
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
  const rootRef = useRef<HTMLDivElement | null>(null);
  const listId = useId();

  const selected = options.find((o) => o.value === value);
  const triggerLabel = selected?.label ?? placeholder ?? value;

  // 点击/触摸组件外部时关闭。
  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
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
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={rootClassName} ref={rootRef} title={title}>
      <button
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
      {open ? (
        <div className="pa-dropdown-menu" role="listbox" id={listId} aria-label={ariaLabel}>
          {options.map((opt, index) => (
            <button
              key={opt.value}
              type="button"
              role="option"
              aria-selected={opt.value === value}
              className={`pa-dropdown-item ${index === activeIndex ? 'active' : ''} ${opt.value === value ? 'selected' : ''}`}
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
        </div>
      ) : null}
    </div>
  );
}

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { PALETTE_REGISTRY, type AppearancePalette } from './paletteRegistry';

/**
 * PaletteSelect —— 自定义配色下拉框（非原生 <select>）。
 *
 * 为什么自定义：原生 <select> 的展开菜单由系统渲染，无法与应用主题统一，
 * 且 <option> 内放不了色点等 DOM。本组件用 listbox 模式自绘下拉，
 * 每项带主色圆点 + 选中勾，主题完全可控。
 *
 * 选项来自 PALETTE_REGISTRY（唯一数据源），新增配色无需改本组件。
 *
 * 可访问性：button(role=combobox) + ul(role=listbox) + li(role=option)，
 * 支持键盘 ↑/↓/Home/End 移动高亮、Enter/Space 选中、Esc 关闭、点外关闭、失焦关闭。
 *
 * 开合过渡：list 挂载后用 data-state=open|closed 驱动 enter/exit；
 * 关闭时先播退场再卸载，避免选中后瞬间消失。
 */

/** 与 CSS `--za-motion-fast` 对齐的退场兜底时长（ms）。 */
const EXIT_MS = 160;

type PanelPhase = 'closed' | 'open' | 'closing';

export function PaletteSelect({
  value,
  onChange,
  label,
}: {
  readonly value: AppearancePalette;
  readonly onChange: (palette: AppearancePalette) => void;
  readonly label: string;
}) {
  const [phase, setPhase] = useState<PanelPhase>('closed');
  const [activeIndex, setActiveIndex] = useState(() =>
    Math.max(
      0,
      PALETTE_REGISTRY.findIndex((palette) => palette.id === value),
    ),
  );
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const exitTimerRef = useRef<number | null>(null);
  const listboxId = useId();

  const selected = PALETTE_REGISTRY.find((palette) => palette.id === value) ?? PALETTE_REGISTRY[0];
  const isExpanded = phase === 'open';
  const isMounted = phase !== 'closed';

  const clearExitTimer = useCallback(() => {
    if (exitTimerRef.current != null) {
      window.clearTimeout(exitTimerRef.current);
      exitTimerRef.current = null;
    }
  }, []);

  const finishClose = useCallback(() => {
    clearExitTimer();
    setPhase('closed');
  }, [clearExitTimer]);

  const openPanel = useCallback(() => {
    clearExitTimer();
    setPhase('open');
  }, [clearExitTimer]);

  const closePanel = useCallback(() => {
    setPhase((prev) => {
      if (prev !== 'open') return prev;
      return 'closing';
    });
  }, []);

  const commit = useCallback(
    (palette: AppearancePalette) => {
      onChange(palette);
      closePanel();
    },
    [onChange, closePanel],
  );

  // 退场结束后卸载；reduced-motion 时跳过等待。
  useEffect(() => {
    if (phase !== 'closing') return;

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduceMotion) {
      finishClose();
      return;
    }

    clearExitTimer();
    exitTimerRef.current = window.setTimeout(() => {
      finishClose();
    }, EXIT_MS);

    return () => clearExitTimer();
  }, [phase, finishClose, clearExitTimer]);

  // 打开时把高亮对齐到当前选中项
  useEffect(() => {
    if (phase === 'open') {
      setActiveIndex(
        Math.max(
          0,
          PALETTE_REGISTRY.findIndex((palette) => palette.id === value),
        ),
      );
    }
  }, [phase, value]);

  // 点击外部关闭（仅在展开态响应）
  useEffect(() => {
    if (phase !== 'open') return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        closePanel();
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [phase, closePanel]);

  // 挂载后下一帧再切 data-state=open，确保 enter 过渡能播
  useEffect(() => {
    if (phase !== 'open') return;
    const node = listRef.current;
    if (!node) return;
    if (node.dataset.state !== 'open') {
      node.dataset.state = 'closed';
      // force reflow so the closed -> open transition actually runs
      void node.offsetHeight;
      node.dataset.state = 'open';
    }
  }, [phase]);

  const onListTransitionEnd = (event: React.TransitionEvent<HTMLUListElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.propertyName !== 'opacity' && event.propertyName !== 'transform') return;
    if (phase === 'closing') {
      finishClose();
    }
  };

  const onTriggerKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openPanel();
    }
  };

  const onListKeyDown = (event: React.KeyboardEvent) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        setActiveIndex((index) => Math.min(PALETTE_REGISTRY.length - 1, index + 1));
        break;
      case 'ArrowUp':
        event.preventDefault();
        setActiveIndex((index) => Math.max(0, index - 1));
        break;
      case 'Home':
        event.preventDefault();
        setActiveIndex(0);
        break;
      case 'End':
        event.preventDefault();
        setActiveIndex(PALETTE_REGISTRY.length - 1);
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        commit(PALETTE_REGISTRY[activeIndex].id);
        break;
      case 'Escape':
        event.preventDefault();
        closePanel();
        break;
      default:
        break;
    }
  };

  const togglePanel = () => {
    if (phase === 'open') {
      closePanel();
      return;
    }
    openPanel();
  };

  return (
    <div className="palette-select" ref={rootRef}>
      <button
        type="button"
        className="palette-select-trigger"
        aria-haspopup="listbox"
        aria-expanded={isExpanded}
        aria-label={label}
        onClick={togglePanel}
        onKeyDown={onTriggerKeyDown}
      >
        <span className="palette-dot" style={{ background: selected.dotColor }} aria-hidden="true" />
        <span className="palette-select-value">{selected.label}</span>
        <span className={`palette-select-caret${isExpanded ? ' open' : ''}`} aria-hidden="true">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
            <path
              d="M6 9l6 6 6-6"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      </button>

      {isMounted ? (
        <ul
          className="palette-select-list"
          role="listbox"
          id={listboxId}
          tabIndex={-1}
          data-state={phase === 'open' ? 'open' : 'closed'}
          aria-activedescendant={`${listboxId}-${activeIndex}`}
          onKeyDown={onListKeyDown}
          onTransitionEnd={onListTransitionEnd}
          ref={(node) => {
            listRef.current = node;
            if (node && phase === 'open') {
              node.focus();
            }
          }}
        >
          {PALETTE_REGISTRY.map((palette, index) => {
            const isSelected = palette.id === value;
            const isActive = index === activeIndex;
            return (
              <li
                key={palette.id}
                id={`${listboxId}-${index}`}
                role="option"
                aria-selected={isSelected}
                className={`palette-select-option${isActive ? ' active' : ''}${
                  isSelected ? ' selected' : ''
                }`}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => commit(palette.id)}
              >
                <span
                  className="palette-dot"
                  style={{ background: palette.dotColor }}
                  aria-hidden="true"
                />
                <span className="palette-select-option-label">{palette.label}</span>
                <span className="palette-select-check" aria-hidden="true">
                  {isSelected ? (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                      <path
                        d="M5 12l5 5L20 6"
                        stroke="currentColor"
                        strokeWidth="2.2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

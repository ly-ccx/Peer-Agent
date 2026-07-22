import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  firstEnabledIndex,
  resolveKeyboardActiveScrollTarget,
  resolveOpenGroupScrollTarget,
  stepEnabledIndex,
} from './cascadingMenuNav.ts';

export interface CascadingMenuGroup {
  readonly id: string;
  readonly label: string;
  readonly items: readonly CascadingMenuItem[];
  /** 整组不可用（例如该 provider 未配置 API Key）。仅作展示语义，二级项仍会渲染但通常置灰。 */
  readonly disabled?: boolean;
}

export interface CascadingMenuItem {
  readonly id: string;
  readonly label: string;
  /** 该项置灰不可选（例如模型未配置 API Key）。 */
  readonly disabled?: boolean;
}

interface MenuCoords {
  readonly left: number;
  /** 向下弹出时用 top；向上弹出时用 bottom 锚定触发器上沿，避免首帧高度为 0 时错位。 */
  readonly top?: number;
  readonly bottom?: number;
  readonly width: number;
  readonly placement: 'down' | 'up';
}

interface SubmenuCoords {
  readonly left: number;
  readonly top: number;
  readonly side: 'right' | 'left';
  /** 基于可用视口空间动态计算，避免长列表被写死高度裁成“像没加上”。 */
  readonly maxHeight: number;
}

type FocusZone = 'root' | 'sub';

// 真·悬浮父子菜单：一级列 provider（group），悬停/右键进入时在右侧弹出该 provider 的模型子菜单（二级）。
// 每个 provider 恒有二级（哪怕只有一个模型）；未配置 Key 的模型以 disabled 置灰、不可选，但仍然列出。
//
// 受控组件:value/onChange（value 为选中项 id）。
// 键盘:一级 ↑↓ 切 provider、→/Enter 进子菜单；二级 ↑↓ 选模型（跳过置灰）、←返回一级、Enter 选择、Esc 关闭。
// 一级面板与二级子菜单均 createPortal 到 document.body，以 position:fixed 定位并自适应上下/左右方向。
export function CascadingMenu({
  value,
  groups,
  onChange,
  disabled = false,
  placeholder,
  ariaLabel,
  className,
  title,
  menuPlacement = 'down',
}: {
  readonly value: string;
  readonly groups: readonly CascadingMenuGroup[];
  readonly onChange: (itemId: string) => void;
  readonly disabled?: boolean;
  readonly placeholder?: string;
  readonly ariaLabel?: string;
  readonly className?: string;
  readonly title?: string;
  readonly menuPlacement?: 'down' | 'up';
}) {
  const [open, setOpen] = useState(false);
  const [activeGroupIndex, setActiveGroupIndex] = useState(-1);
  const [activeItemIndex, setActiveItemIndex] = useState(-1);
  const [focusZone, setFocusZone] = useState<FocusZone>('root');
  const [coords, setCoords] = useState<MenuCoords | null>(null);
  const [submenuCoords, setSubmenuCoords] = useState<SubmenuCoords | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const submenuRef = useRef<HTMLDivElement | null>(null);
  const groupRowRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const listId = useId();
  const [submenuScrollState, setSubmenuScrollState] = useState({ canUp: false, canDown: false });
  // 仅键盘 ↑↓ 导航时需要把“当前高亮项”滚进可视区；悬停切高亮绝不能触发回滚。
  const scrollActiveItemOnNavRef = useRef(false);

  // 查找当前选中项对应的分组和项目，用于触发器展示「分组 · 模型」。
  const selectedGroupIndex = groups.findIndex((g) => g.items.some((item) => item.id === value));
  const selectedGroup = selectedGroupIndex >= 0 ? groups[selectedGroupIndex] : undefined;
  const selectedItem = selectedGroup?.items.find((item) => item.id === value);
  const triggerLabel = selectedGroup && selectedItem
    ? `${selectedGroup.label} · ${selectedItem.label}`
    : placeholder ?? value;

  const activeGroup = activeGroupIndex >= 0 ? groups[activeGroupIndex] : undefined;
  const submenuItems = activeGroup?.items ?? [];

  // 依据触发器在视口中的位置计算一级 fixed 菜单坐标，并按可用空间自适应上下方向。
  // 向上弹出时用 bottom 锚定触发器上沿（贴齐底部触发器），不依赖首帧 menu 高度。
  // 水平方向优先与触发器左对齐；面板更宽贴右边界时左移，避免溢出。
  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const gap = 4;
    const margin = 8;
    const viewportH = window.innerHeight;
    const viewportW = window.innerWidth;
    const menuH = menuRef.current?.offsetHeight ?? 0;
    const menuW = menuRef.current?.offsetWidth ?? Math.max(rect.width, 160);
    const spaceBelow = viewportH - rect.bottom - gap;
    const spaceAbove = rect.top - gap;
    let placement: MenuCoords['placement'] = menuPlacement;
    if (placement === 'down' && menuH > 0 && spaceBelow < menuH && spaceAbove > spaceBelow) {
      placement = 'up';
    } else if (placement === 'up' && menuH > 0 && spaceAbove < menuH && spaceBelow > spaceAbove) {
      placement = 'down';
    }

    // 模型选择器在底部工具栏：向上时优先右对齐触发器，视觉上更贴触发器；向下仍左对齐。
    let left = placement === 'up' ? rect.right - menuW : rect.left;
    if (left + menuW > viewportW - margin) {
      left = Math.max(margin, viewportW - menuW - margin);
    }
    if (left < margin) left = margin;

    if (placement === 'up') {
      setCoords({
        left,
        bottom: Math.max(gap, viewportH - rect.top + gap),
        width: rect.width,
        placement,
      });
      return;
    }
    setCoords({
      left,
      top: rect.bottom + gap,
      width: rect.width,
      placement,
    });
  }, [menuPlacement]);

  // 依据当前展开的 group 行位置，计算二级子菜单坐标与可用高度：
  // 默认贴一级面板右侧并与当前 group 行顶对齐；贴右边界时翻向左侧；
  // 垂直方向优先与 group 行顶对齐，必要时再贴视口底边；
  // maxHeight 跟随视口可用空间，避免长列表被固定高度裁切成“像没加上”。
  const updateSubmenuPosition = useCallback(() => {
    const panel = menuRef.current;
    const row = groupRowRefs.current[activeGroupIndex];
    if (!panel || !row) {
      setSubmenuCoords(null);
      return;
    }
    const panelRect = panel.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const gap = 0;
    const margin = 8;
    const subW = submenuRef.current?.offsetWidth ?? 220;
    const preferredTop = Math.max(margin, Math.min(rowRect.top, panelRect.top));
    const maxHeight = Math.max(160, window.innerHeight - preferredTop - margin);
    const measuredH = submenuRef.current?.scrollHeight ?? 0;
    const subH = measuredH > 0 ? Math.min(measuredH, maxHeight) : maxHeight;
    let left = panelRect.right + gap;
    let side: SubmenuCoords['side'] = 'right';
    if (left + subW > window.innerWidth - margin) {
      left = Math.max(margin, panelRect.left - subW - gap);
      side = 'left';
    }
    // 与一级当前行顶对齐；若底部溢出则整体上移，但不高于一级面板顶。
    let top = preferredTop;
    if (top + subH > window.innerHeight - margin) {
      top = Math.max(margin, window.innerHeight - subH - margin);
    }
    if (top < panelRect.top) {
      top = Math.max(margin, panelRect.top);
    }
    const finalMaxHeight = Math.max(160, window.innerHeight - top - margin);
    setSubmenuCoords({ left, top, side, maxHeight: finalMaxHeight });
  }, [activeGroupIndex]);

  useLayoutEffect(() => {
    if (open) updatePosition();
  }, [open, updatePosition]);

  useLayoutEffect(() => {
    if (open && activeGroupIndex >= 0) updateSubmenuPosition();
    else setSubmenuCoords(null);
  }, [open, activeGroupIndex, coords, updateSubmenuPosition]);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      const inRoot = rootRef.current?.contains(target) ?? false;
      const inMenu = menuRef.current?.contains(target) ?? false;
      const inSub = submenuRef.current?.contains(target) ?? false;
      if (!inRoot && !inMenu && !inSub) setOpen(false);
    };
    const onResize = () => {
      updatePosition();
      updateSubmenuPosition();
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('resize', onResize);
    };
  }, [open, updatePosition, updateSubmenuPosition]);

  const selectItem = useCallback((itemId: string) => {
    onChange(itemId);
    setOpen(false);
  }, [onChange]);

  const openMenu = useCallback(() => {
    const gi = selectedGroupIndex >= 0 ? selectedGroupIndex : (groups.length > 0 ? 0 : -1);
    setActiveGroupIndex(gi);
    setActiveItemIndex(-1);
    setFocusZone('root');
    setOpen(true);
  }, [groups.length, selectedGroupIndex]);

  const updateSubmenuScrollState = useCallback(() => {
    const el = submenuRef.current;
    if (!el) {
      setSubmenuScrollState({ canUp: false, canDown: false });
      return;
    }
    const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight);
    const canUp = el.scrollTop > 1;
    const canDown = el.scrollTop < maxScroll - 1;
    setSubmenuScrollState({ canUp, canDown });
  }, []);

  const enterSubmenu = useCallback((gi: number) => {
    const items = groups[gi]?.items ?? [];
    if (items.length === 0) return;
    setActiveGroupIndex(gi);
    setFocusZone('sub');
    const selIdx = items.findIndex((it) => it.id === value && !it.disabled);
    setActiveItemIndex(selIdx >= 0 ? selIdx : firstEnabledIndex(items));
  }, [groups, value]);

  // 打开/切换分组后，只把当前选中模型滚进可视区；悬停切换 activeItemIndex 时绝不回跳。
  // 键盘 ↑↓ 则额外把“当前高亮项”滚进可视区（由 scrollActiveItemOnNavRef 门控）。
  useLayoutEffect(() => {
    if (!open || !submenuCoords || activeGroupIndex < 0) {
      setSubmenuScrollState({ canUp: false, canDown: false });
      scrollActiveItemOnNavRef.current = false;
      return;
    }
    const items = groups[activeGroupIndex]?.items ?? [];
    const selectedIdx = items.findIndex((it) => it.id === value);
    const target = resolveOpenGroupScrollTarget(selectedIdx);
    if (target.kind === 'index') {
      itemRefs.current[target.index]?.scrollIntoView({ block: 'nearest' });
    }
    updateSubmenuScrollState();
  }, [open, submenuCoords, activeGroupIndex, groups, value, updateSubmenuScrollState]);

  useLayoutEffect(() => {
    if (!open || !submenuCoords || activeGroupIndex < 0) return;
    const keyboardNav = scrollActiveItemOnNavRef.current;
    scrollActiveItemOnNavRef.current = false;
    const target = resolveKeyboardActiveScrollTarget(keyboardNav, activeItemIndex);
    if (target.kind !== 'index') return;
    itemRefs.current[target.index]?.scrollIntoView({ block: 'nearest' });
    updateSubmenuScrollState();
  }, [activeItemIndex, open, submenuCoords, activeGroupIndex, updateSubmenuScrollState]);

  const onKeyDown = useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
    if (disabled) return;
    if (!open) {
      if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        openMenu();
      }
      return;
    }
    if (focusZone === 'root') {
      switch (event.key) {
        case 'Escape':
          event.preventDefault();
          setOpen(false);
          break;
        case 'ArrowDown':
          event.preventDefault();
          setActiveGroupIndex((i) => (i < 0 ? 0 : Math.min(i + 1, groups.length - 1)));
          break;
        case 'ArrowUp':
          event.preventDefault();
          setActiveGroupIndex((i) => (i < 0 ? groups.length - 1 : Math.max(i - 1, 0)));
          break;
        case 'ArrowRight':
        case 'Enter':
        case ' ':
          event.preventDefault();
          enterSubmenu(activeGroupIndex < 0 ? 0 : activeGroupIndex);
          break;
        default:
          break;
      }
      return;
    }
    // focusZone === 'sub'
    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        setOpen(false);
        break;
      case 'ArrowLeft':
        event.preventDefault();
        setFocusZone('root');
        break;
      case 'ArrowDown':
        event.preventDefault();
        scrollActiveItemOnNavRef.current = true;
        setActiveItemIndex((i) => stepEnabledIndex(submenuItems, i < 0 ? -1 : i, 1));
        break;
      case 'ArrowUp':
        event.preventDefault();
        scrollActiveItemOnNavRef.current = true;
        setActiveItemIndex((i) => stepEnabledIndex(submenuItems, i < 0 ? 0 : i, -1));
        break;
      case 'Enter':
      case ' ': {
        event.preventDefault();
        const it = submenuItems[activeItemIndex];
        if (it && !it.disabled) selectItem(it.id);
        break;
      }
      default:
        break;
    }
  }, [disabled, open, focusZone, groups.length, activeGroupIndex, activeItemIndex, submenuItems, enterSubmenu, openMenu, selectItem]);

  const rootClassName = [
    'pa-cascading-menu',
    menuPlacement === 'up' ? 'pa-cascading-menu-up' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  const menuStyle: CSSProperties & { '--pa-cascading-menu-width'?: string } = coords
    ? {
        position: 'fixed',
        left: coords.left,
        ...(coords.placement === 'up'
          ? { bottom: coords.bottom, top: 'auto' }
          : { top: coords.top, bottom: 'auto' }),
        '--pa-cascading-menu-width': `${coords.width}px`,
      }
    : { position: 'fixed', left: 0, top: 0, visibility: 'hidden' };

  const submenuStyle: CSSProperties = submenuCoords
    ? {
        position: 'fixed',
        left: submenuCoords.left,
        top: submenuCoords.top,
        maxHeight: submenuCoords.maxHeight,
      }
    : { position: 'fixed', left: 0, top: 0, visibility: 'hidden' };

  const rootPanel = open
    ? createPortal(
        <div
          ref={menuRef}
          className={`pa-cascading-menu-panel ${className ?? ''} ${coords?.placement === 'up' ? 'is-up' : 'is-down'}`}
          role="menu"
          id={listId}
          aria-label={ariaLabel}
          style={menuStyle}
          onKeyDown={onKeyDown}
        >
          {groups.map((group, gi) => {
            const isActive = gi === activeGroupIndex;
            const isSelected = gi === selectedGroupIndex;
            return (
              <button
                key={group.id}
                ref={(el) => {
                  groupRowRefs.current[gi] = el;
                }}
                type="button"
                role="menuitem"
                aria-haspopup="menu"
                aria-expanded={isActive}
                className={`pa-cascading-group-row ${isActive ? 'active' : ''} ${isSelected ? 'selected' : ''} ${group.disabled ? 'group-disabled' : ''}`}
                onMouseEnter={() => {
                  setActiveGroupIndex(gi);
                  setFocusZone('root');
                }}
                onMouseDown={(event) => {
                  event.preventDefault();
                  enterSubmenu(gi);
                }}
              >
                <span className="pa-cascading-group-label">{group.label}</span>
                <svg
                  className="pa-cascading-group-arrow"
                  aria-hidden
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="m9 18 6-6-6-6" />
                </svg>
              </button>
            );
          })}
        </div>,
        document.body,
      )
    : null;

  const submenuPanel = open && activeGroup
    ? createPortal(
        <div
          ref={submenuRef}
          className={[
            'pa-cascading-submenu-panel',
            className ?? '',
            submenuCoords?.side === 'left' ? 'is-left' : 'is-right',
            submenuScrollState.canUp ? 'can-scroll-up' : '',
            submenuScrollState.canDown ? 'can-scroll-down' : '',
          ]
            .filter(Boolean)
            .join(' ')}
          role="menu"
          aria-label={activeGroup.label}
          style={submenuStyle}
          onKeyDown={onKeyDown}
          onScroll={updateSubmenuScrollState}
        >
          {submenuItems.map((item, ii) => {
            const itemDisabled = item.disabled ?? false;
            const isActive = focusZone === 'sub' && ii === activeItemIndex;
            const isSelected = item.id === value;
            return (
              <button
                key={item.id}
                ref={(node) => {
                  itemRefs.current[ii] = node;
                }}
                type="button"
                role="menuitemradio"
                aria-checked={isSelected}
                aria-disabled={itemDisabled}
                disabled={itemDisabled}
                className={`pa-cascading-item ${isActive ? 'active' : ''} ${isSelected ? 'selected' : ''} ${itemDisabled ? 'disabled' : ''}`}
                onMouseEnter={() => {
                  if (!itemDisabled) {
                    setFocusZone('sub');
                    setActiveItemIndex(ii);
                  }
                }}
                onMouseDown={(event) => {
                  event.preventDefault();
                  if (!itemDisabled) selectItem(item.id);
                }}
              >
                <span className="pa-cascading-item-label">{item.label}</span>
                {isSelected ? (
                  <svg
                    className="pa-cascading-item-check"
                    aria-hidden
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                ) : null}
              </button>
            );
          })}
        </div>,
        document.body,
      )
    : null;

  return (
    <div className={rootClassName} ref={rootRef} title={title}>
      <button
        ref={triggerRef}
        type="button"
        className={`pa-cascading-trigger ${open ? 'open' : ''}`}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={ariaLabel}
        onClick={() => {
          if (disabled) return;
          if (open) setOpen(false);
          else openMenu();
        }}
        onKeyDown={onKeyDown}
      >
        <span className="pa-cascading-value">{triggerLabel}</span>
        <svg
          className="pa-cascading-caret"
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
      {rootPanel}
      {submenuPanel}
    </div>
  );
}

// CascadingMenu 的纯导航逻辑：从二级子菜单项中选择「可用（未 disabled）」项。
// 抽成独立无 JSX 模块，便于用 node:test 直接单测，不牵连 React 组件。

export interface CascadingNavItem {
  readonly disabled?: boolean;
}

// 返回首个可用项索引；全不可用时回退到 0；空列表返回 -1。
export function firstEnabledIndex(items: readonly CascadingNavItem[]): number {
  const idx = items.findIndex((it) => !it.disabled);
  return idx >= 0 ? idx : (items.length > 0 ? 0 : -1);
}

// 从 from 出发按 dir 方向环绕查找下一个可用（未 disabled）项的索引。
// 无任何可用项时返回原 from（不移动）；空列表返回 -1。
export function stepEnabledIndex(items: readonly CascadingNavItem[], from: number, dir: 1 | -1): number {
  const n = items.length;
  if (n === 0) return -1;
  let i = from;
  for (let step = 0; step < n; step += 1) {
    i += dir;
    if (i < 0) i = n - 1;
    if (i >= n) i = 0;
    if (!items[i]?.disabled) return i;
  }
  return from;
}

/** 子菜单应滚到哪一项；none 表示保持用户当前滚动位置。 */
export type SubmenuScrollTarget =
  | { readonly kind: 'index'; readonly index: number }
  | { readonly kind: 'none' };

// 打开菜单 / 切换一级分组时：优先滚到已选 value 对应项；没有已选项时不强制滚动。
export function resolveOpenGroupScrollTarget(selectedIdx: number): SubmenuScrollTarget {
  if (selectedIdx >= 0) return { kind: 'index', index: selectedIdx };
  return { kind: 'none' };
}

// 仅键盘 ↑↓ 导航时才跟随 activeItemIndex；悬停切换高亮必须返回 none，避免列表回跳到已选项。
export function resolveKeyboardActiveScrollTarget(
  keyboardNav: boolean,
  activeItemIndex: number,
): SubmenuScrollTarget {
  if (!keyboardNav || activeItemIndex < 0) return { kind: 'none' };
  return { kind: 'index', index: activeItemIndex };
}

export interface CascadingSubmenuAnchorInput {
  readonly panelRect: { readonly left: number; readonly right: number; readonly top: number };
  readonly rowRect: { readonly top: number };
  readonly submenuWidth: number;
  readonly submenuHeight: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly margin?: number;
  readonly gap?: number;
}

export interface CascadingSubmenuAnchor {
  readonly left: number;
  readonly top: number;
  readonly side: 'left' | 'right';
  readonly maxHeight: number;
}

/**
 * Anchor the submenu to the hovered primary row (not the primary panel top).
 * Flip left near the right edge; if it would overflow the bottom, slide up within the viewport.
 */
export function resolveCascadingSubmenuAnchor(input: CascadingSubmenuAnchorInput): CascadingSubmenuAnchor {
  const margin = input.margin ?? 8;
  const gap = input.gap ?? 0;
  const subW = Math.max(0, input.submenuWidth);
  const measuredH = Math.max(0, input.submenuHeight);
  // Source of truth: the hovered provider row, not panelRect.top.
  const preferredTop = Math.max(margin, input.rowRect.top);
  const maxHeight = Math.max(160, input.viewportHeight - preferredTop - margin);
  const subH = measuredH > 0 ? Math.min(measuredH, maxHeight) : maxHeight;

  let left = input.panelRect.right + gap;
  let side: CascadingSubmenuAnchor['side'] = 'right';
  if (left + subW > input.viewportWidth - margin) {
    left = Math.max(margin, input.panelRect.left - subW - gap);
    side = 'left';
  }

  let top = preferredTop;
  if (top + subH > input.viewportHeight - margin) {
    top = Math.max(margin, input.viewportHeight - subH - margin);
  }

  const finalMaxHeight = Math.max(160, input.viewportHeight - top - margin);
  return { left, top, side, maxHeight: finalMaxHeight };
}

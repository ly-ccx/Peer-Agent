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

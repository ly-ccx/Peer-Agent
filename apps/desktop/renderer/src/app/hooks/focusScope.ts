/** Native Tab ordering within a modal; null means the browser may advance normally. */
export function focusBoundary<T>(items: readonly T[], active: T | null, backwards: boolean): T | null {
  if (!items.length) return null;
  if (!items.includes(active as T)) return backwards ? items.at(-1)! : items[0]!;
  if (backwards && active === items[0]) return items.at(-1)!;
  if (!backwards && active === items.at(-1)) return items[0]!;
  return null;
}

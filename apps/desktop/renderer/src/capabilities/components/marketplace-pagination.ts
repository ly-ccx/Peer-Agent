/**
 * 市场页码折叠：当前页附近 ±2，首尾页固定，中间断点用省略号。
 * 形如：1 … 8 9 [10] 11 12 … 312
 */
export type MarketplacePageItem =
  | { readonly key: string; readonly type: 'page'; readonly page: number }
  | { readonly key: string; readonly type: 'ellipsis' };

export function buildPageItems(current: number, total: number): readonly MarketplacePageItem[] {
  const safeTotal = Number.isFinite(total) ? Math.max(1, Math.trunc(total)) : 1;
  const safeCurrent = Number.isFinite(current) ? Math.min(safeTotal, Math.max(1, Math.trunc(current))) : 1;
  const items: MarketplacePageItem[] = [];
  const window = 2;
  const seen = new Set<number>();
  const push = (page: number) => {
    if (page >= 1 && page <= safeTotal && !seen.has(page)) {
      seen.add(page);
      items.push({ key: `p${page}`, type: 'page', page });
    }
  };
  push(1);
  for (let delta = -window; delta <= window; delta += 1) push(safeCurrent + delta);
  push(safeTotal);
  const pages = items
    .filter((item): item is Extract<MarketplacePageItem, { type: 'page' }> => item.type === 'page')
    .map((item) => item.page)
    .sort((a, b) => a - b);
  const result: MarketplacePageItem[] = [];
  pages.forEach((pageNumber, index) => {
    if (index > 0 && pageNumber - pages[index - 1] > 1) {
      result.push({ key: `e${pages[index - 1]}-${pageNumber}`, type: 'ellipsis' });
    }
    result.push({ key: `p${pageNumber}`, type: 'page', page: pageNumber });
  });
  return result;
}

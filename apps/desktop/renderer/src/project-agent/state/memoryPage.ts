import { filterMemoryRecords, type MemoryRecord, type MemoryFilter } from './drawerState.ts';

export const MEMORY_PAGE_SIZE = 50;

/** Filter the complete result, then expose a bounded page without changing memory facts. */
export function memoryPage(items: readonly MemoryRecord[], filter: MemoryFilter, requested: number) {
  const filtered = filterMemoryRecords(items, filter);
  const pages = Math.ceil(filtered.length / MEMORY_PAGE_SIZE);
  const page = Math.max(0, Math.min(Math.max(0, pages - 1), Number.isFinite(requested) ? Math.floor(requested) : 0));
  const start = page * MEMORY_PAGE_SIZE;
  const visible = filtered.slice(start, start + MEMORY_PAGE_SIZE);
  return { items: visible, page, pages, total: filtered.length, start: visible.length ? start + 1 : 0, end: start + visible.length };
}

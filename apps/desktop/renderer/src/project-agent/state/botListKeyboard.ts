/** Only the focused list/search owns unmodified navigation keys. */
export function botListKey(ids: readonly string[], current: string | null, key: string) {
  if (!ids.length) return null;
  const found = ids.indexOf(current ?? '');
  const index = Math.max(0, found);
  if (key === 'Home') return { id: ids[0]!, open: false };
  if (key === 'End') return { id: ids.at(-1)!, open: false };
  if (key === 'ArrowDown' || key === 'ArrowUp') return {
    id: ids[Math.max(0, Math.min(ids.length - 1, (found < 0 ? (key === 'ArrowDown' ? -1 : ids.length) : index) + (key === 'ArrowDown' ? 1 : -1)))]!, open: false,
  };
  if (key === 'Enter' || key === ' ') return { id: ids[index]!, open: true };
  return null;
}

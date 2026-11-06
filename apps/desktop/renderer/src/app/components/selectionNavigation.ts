/** Selection follows an explicit navigation key, never an asynchronous list refresh. */
export function selectionNavigation(items: readonly { disabled?: boolean }[], from: number, key: string,
  orientation: 'horizontal' | 'vertical' = 'horizontal', rtl = false): number | null {
  const enabled = items.flatMap((item, index) => item.disabled ? [] : [index]);
  if (!enabled.length) return null;
  if (key === 'Home') return enabled[0]!;
  if (key === 'End') return enabled.at(-1)!;
  const next = orientation === 'vertical' ? key === 'ArrowDown' : key === (rtl ? 'ArrowLeft' : 'ArrowRight');
  const previous = orientation === 'vertical' ? key === 'ArrowUp' : key === (rtl ? 'ArrowRight' : 'ArrowLeft');
  if (!next && !previous) return null;
  const current = enabled.indexOf(from);
  return enabled[(current < 0 ? next ? 0 : enabled.length - 1 : current + (next ? 1 : -1) + enabled.length) % enabled.length]!;
}

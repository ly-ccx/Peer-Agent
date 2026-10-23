/** Motion is optional presentation. Missing browser APIs keep the static surface usable. */
export function prefersReducedMotion(): boolean {
  try { return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
  catch { return true; }
}
export function motionAllowed(): boolean {
  return typeof document !== 'undefined' && !document.hidden && typeof window !== 'undefined'
    && typeof window.matchMedia === 'function' && !prefersReducedMotion();
}
export function subscribeMotionEnvironment(update: () => void): () => void {
  if (typeof document === 'undefined' || typeof window === 'undefined') return () => {};
  let preference: MediaQueryList | null = null;
  try { preference = window.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null; } catch { /* Static fallback. */ }
  document.addEventListener('visibilitychange', update);
  if (preference?.addEventListener) preference.addEventListener('change', update);
  else preference?.addListener?.(update);
  return () => {
    document.removeEventListener('visibilitychange', update);
    if (preference?.removeEventListener) preference.removeEventListener('change', update);
    else preference?.removeListener?.(update);
  };
}
export const browserMotionEnvironment = { allowed: motionAllowed, subscribe: subscribeMotionEnvironment };

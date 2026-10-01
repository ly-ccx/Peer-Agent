import { useEffect, useRef, useState } from 'react';
import { createAvatarMotionRegistry } from './avatarMotionRegistry';
const registry = createAvatarMotionRegistry<Element>({
  observe(update) {
    const observer = new IntersectionObserver(entries => entries.forEach(entry => update(entry.target, entry.isIntersecting)));
    return observer;
  },
  allowed: () => !document.hidden && !window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  subscribe(update) {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    document.addEventListener('visibilitychange', update); preference.addEventListener('change', update);
    return () => { document.removeEventListener('visibilitychange', update); preference.removeEventListener('change', update); };
  },
});
export function useAvatarMotion() {
  const ref = useRef<HTMLSpanElement>(null), [active, setActive] = useState(false);
  useEffect(() => ref.current ? registry.observe(ref.current, setActive) : undefined, []);
  return { ref, active };
}

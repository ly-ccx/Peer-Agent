import { useEffect, useRef, useState } from 'react';
import { createAvatarMotionRegistry } from './avatarMotionRegistry';
import { motionAllowed, subscribeMotionEnvironment } from '../../app/state/motionEnvironment';
const registry = createAvatarMotionRegistry<Element>({
  observe(update) {
    if (typeof IntersectionObserver !== 'function') return { observe(node: Element) { update(node, false); }, unobserve() {}, disconnect() {} };
    const observer = new IntersectionObserver(entries => entries.forEach(entry => update(entry.target, entry.isIntersecting)));
    return observer;
  },
  allowed: motionAllowed,
  subscribe: subscribeMotionEnvironment,
});
export function useAvatarMotion(eligible = false) {
  const ref = useRef<HTMLSpanElement>(null), [active, setActive] = useState(false);
  useEffect(() => {
    if (!eligible) { setActive(false); return; }
    return ref.current ? registry.observe(ref.current, setActive) : undefined;
  }, [eligible]);
  return { ref, active: eligible && active };
}

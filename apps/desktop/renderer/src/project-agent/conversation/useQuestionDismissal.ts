import { useLayoutEffect, useRef, useState } from 'react';
import { motionDurationMs } from '../state/conversationMotion';

/** Retain a resolved question only while its measured footprint closes. */
export function useQuestionDismissal(resolved: boolean, onClosed?: () => void) {
  const ref = useRef<HTMLElement>(null);
  const [present, setPresent] = useState(!resolved);
  const closed = useRef(onClosed); closed.current = onClosed;
  useLayoutEffect(() => {
    if (!resolved) { setPresent(true); return; }
    const node = ref.current;
    if (!present || !node) return;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { setPresent(false); closed.current?.(); return; }
    const style = getComputedStyle(node);
    const animation = node.animate([
      { height: `${node.getBoundingClientRect().height}px`, opacity: 1, marginTop: style.marginTop, paddingTop: style.paddingTop },
      { height: '0px', opacity: 0, marginTop: '0px', paddingTop: '0px', borderTopWidth: '0px' },
    ], { duration: motionDurationMs(style.getPropertyValue('--za-motion-medium')),
      easing: style.getPropertyValue('--za-ease-standard').trim() || 'ease', fill: 'forwards' });
    let active = true;
    void animation.finished.then(() => { if (active) { setPresent(false); closed.current?.(); } }).catch(() => {});
    return () => { active = false; animation.cancel(); };
  }, [resolved, present]);
  return { ref, present };
}

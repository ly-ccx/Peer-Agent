import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { motionAllowed } from '../../app/state/motionEnvironment';
import { motionDurationMs, watchVisualMotion } from '../../app/state/visualMotion';

/** Keep a fresh input/reply's DOM identity while its intrinsic footprint enters. */
export function ConversationRow({ rowKey, entering, className, children }: {
  readonly rowKey: string; readonly entering: boolean; readonly className: string; readonly children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [arriving, setArriving] = useState(() => entering && motionAllowed()
    && typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('interpolate-size', 'allow-keywords'));
  useLayoutEffect(() => {
    const node = ref.current;
    if (!arriving || !node) return;
    if (typeof node.getAnimations !== 'function') { setArriving(false); return; }
    try {
      const style = getComputedStyle(node);
      const animations = node.getAnimations().filter(animation => 'animationName' in animation
        && animation.animationName === 'motion-enter-layout');
      return watchVisualMotion(animations, () => setArriving(false), {
        durationMs: motionDurationMs(style.getPropertyValue('--za-motion-medium')),
      }).cancel;
    } catch { setArriving(false); }
  }, [arriving]);
  return <div ref={ref} className={`${className}${arriving ? ' motion-enter-layout' : ''}`}
    data-conversation-row={rowKey}>{children}</div>;
}

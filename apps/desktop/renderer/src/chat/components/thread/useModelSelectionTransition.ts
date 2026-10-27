import { useLayoutEffect, useRef, type RefObject } from 'react';
import { animateVisual, motionDurationMs } from '../../../app/state/visualMotion';

/** Keep one live panel and its controls; only provider changes fade the inner content. */
export function useModelSelectionTransition(
  panel: RefObject<HTMLDivElement | null>,
  body: RefObject<HTMLDivElement | null>,
  providerId: string | undefined,
  modelId: string,
  effortCount: number,
  fastAvailable: boolean,
  embedded: boolean,
) {
  const height = useRef<number | null>(null);
  const provider = useRef(providerId);
  useLayoutEffect(() => {
    const node = panel.current;
    if (!node) return;
    const previousHeight = height.current, nextHeight = node.getBoundingClientRect().height;
    const switched = provider.current !== providerId;
    provider.current = providerId;
    height.current = nextHeight;
    const style = getComputedStyle(node);
    const easing = style.getPropertyValue('--za-ease-standard').trim() || 'ease';
    let resizing = false;
    let resize: ReturnType<typeof animateVisual> | undefined;
    if (!embedded && previousHeight !== null && Math.abs(previousHeight - nextHeight) > 1) {
      resizing = true;
      resize = animateVisual(node, [{ height: `${previousHeight}px` }, { height: `${nextHeight}px` }], {
        duration: motionDurationMs(style.getPropertyValue('--za-motion-medium')), easing,
      }, () => { resizing = false; });
    }
    const content = switched ? animateVisual(body.current, [{ opacity: 0.7 }, { opacity: 1 }], {
      duration: motionDurationMs(style.getPropertyValue('--za-motion-fast'), 120), easing,
    }) : undefined;
    return () => {
      // A rapid second choice starts at the current visible height, not an old endpoint.
      if (resizing) height.current = node.getBoundingClientRect().height;
      resize?.cancel();
      content?.cancel();
    };
  }, [panel, body, providerId, modelId, effortCount, fastAvailable, embedded]);
}

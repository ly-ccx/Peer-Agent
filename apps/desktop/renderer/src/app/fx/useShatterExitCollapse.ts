import { useLayoutEffect, type RefObject } from 'react';
import { ACCEPTANCE_EXIT_MS, type AcceptancePhase } from '../state/acceptanceTransition';

/** 与 particle-shatter.css 的 max-height 过渡保持同一条曲线。 */
const COLLAPSE_EASING = 'cubic-bezier(0.33, 0, 0.2, 1)';

/**
 * 退场高度塌缩（配合 particle-shatter.css 的 `.is-exiting { max-height: 0 }`）。
 *
 * 宿主静止态是 `max-height: none`，`none → 0` 不可插值，CSS 过渡只会瞬跳，
 * 列表其余卡片随之猛地顶上来。
 *
 * 进入 exiting 的布局阶段（绘制前）用 WAAPI 直接驱动 max-height：
 * 1. 内联 `max-height: none` 临时解除类限制，读回自然高度（此刻类已生效，
 *    不解除读到的是 0）；
 * 2. 清掉内联值，交给类规则的 0；
 * 3. `animate()` 从自然高度过渡到 0 —— 动画层优先于过渡层，直接接管渲染值，
 *    避开 CSS 过渡起点取值的坑（0→0 空过渡会让塌缩瞬间完成）。
 *
 * 时长与 ACCEPTANCE_EXIT_MS 一致：动画走完即被 onSettled 移除，
 * 落回类规则(max-height:0) 的静态值，不留填充帧。
 * prefers-reduced-motion 下跳过：CSS 已禁用过渡，直接跳变是预期。
 */
export function useShatterExitCollapse(
  phase: AcceptancePhase | null,
  hostRef: RefObject<HTMLElement | null>,
): void {
  useLayoutEffect(() => {
    if (phase !== 'exiting') return;
    const host = hostRef.current;
    if (!host) return;
    if (
      typeof host.animate !== 'function' ||
      typeof window.matchMedia !== 'function' ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      return;
    }
    host.style.maxHeight = 'none';
    const height = host.offsetHeight;
    host.style.maxHeight = '';
    if (height <= 0) return;
    host.animate(
      [{ maxHeight: `${height}px` }, { maxHeight: '0px' }],
      { duration: ACCEPTANCE_EXIT_MS, easing: COLLAPSE_EASING },
    );
  }, [phase, hostRef]);
}

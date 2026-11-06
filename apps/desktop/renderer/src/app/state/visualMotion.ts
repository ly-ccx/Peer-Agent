import { browserMotionEnvironment } from './motionEnvironment.ts';

/** Browser computed CSS times may use seconds. Invalid/negative values keep the semantic default. */
export function motionDurationMs(value: string, fallback = 200): number {
  const match = /^(\d*\.?\d+)(ms|s)$/.exec(value.trim());
  const duration = match ? Number(match[1]) * (match[2] === 's' ? 1000 : 1) : fallback;
  return Number.isFinite(duration) ? duration : fallback;
}

/** Only presentation completion belongs here; callers dispatch business actions before animation. */
export function watchVisualMotion(animations: readonly Animation[], onFinish: () => void, options: {
  durationMs?: number;
  environment?: typeof browserMotionEnvironment;
  schedule?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clear?: (timer: ReturnType<typeof setTimeout>) => void;
  /** Let CSS deliver its terminal geometry/end event before cancelling its fill. */
  preserveFinalFrame?: boolean;
  /** A CSS observer can detach during effect replay without owning the DOM animation. */
  preserveAnimationOnCancel?: boolean;
  requestFrame?: (callback: () => void) => number;
  cancelFrame?: (frame: number) => void;
} = {}) {
  const environment = options.environment ?? browserMotionEnvironment;
  const schedule = options.schedule ?? setTimeout, clear = options.clear ?? clearTimeout;
  const duration = Math.max(0, options.durationMs ?? 0);
  let live = true, timer: ReturnType<typeof setTimeout> | null = null, frame: number | null = null, unsubscribe = () => {};
  const requestFrame = options.requestFrame ?? (typeof globalThis.requestAnimationFrame === 'function' ? (fn: () => void) => globalThis.requestAnimationFrame(fn) : undefined);
  const cancelFrame = options.cancelFrame ?? ((id: number) => globalThis.cancelAnimationFrame?.(id));
  const stop = (notify: boolean) => {
    if (!live) return;
    live = false;
    if (timer !== null) clear(timer);
    if (frame !== null) cancelFrame(frame);
    unsubscribe();
    if (notify || !options.preserveAnimationOnCancel) {
      for (const animation of animations) { try { animation.cancel(); } catch { /* Detached/unsupported animation. */ } }
    }
    if (notify) onFinish();
  };
  const finish = () => stop(true), cancel = () => stop(false);
  const arm = (ms: number) => { if (!live) return; if (timer !== null) clear(timer); timer = schedule(finish, ms); };
  if (!environment.allowed()) { finish(); return { finish, cancel }; }
  unsubscribe = environment.subscribe(() => { if (!environment.allowed()) finish(); });
  if (!live) { unsubscribe(); return { finish, cancel }; }
  if (!animations.length) {
    if (duration > 0) arm(duration); else finish();
    return { finish, cancel };
  }
  // A pending start cannot hold a disappearing layer indefinitely.
  arm(2000);
  try {
    void Promise.allSettled(animations.map(animation => animation.finished)).then(results => {
      if (!live) return;
      if (options.preserveFinalFrame && requestFrame && results.every(result => result.status === 'fulfilled')) {
        try { frame = requestFrame(() => { frame = null; finish(); }); } catch { finish(); }
      } else finish();
    });
    void Promise.allSettled(animations.map(animation => animation.ready)).then(() => {
      if (!live) return;
      // A delayed rendering task can outlast endTime + padding. Keep the existing
      // hard bound while CSS gets its real terminal frame and native end event.
      if (options.preserveFinalFrame) return;
      try {
        const remaining = animations.map(animation => {
          const end = animation.effect?.getComputedTiming().endTime;
          const time = typeof animation.currentTime === 'number' ? animation.currentTime : 0;
          return typeof end === 'number' && Number.isFinite(end)
            ? Math.max(0, end - time) / (Math.abs(animation.playbackRate) || 1) : 0;
        });
        arm(Math.min(2000, Math.max(duration, ...remaining) + 60));
      } catch { finish(); }
    });
  } catch { finish(); }
  return { finish, cancel };
}

/** Layout/WAAPI can be absent or fail; either case reaches the same static end state. */
export function animateVisual(node: HTMLElement | null, frames: Keyframe[], timing: KeyframeAnimationOptions,
  onFinish: () => void = () => {}) {
  if (!browserMotionEnvironment.allowed() || !node || typeof node.animate !== 'function') return watchVisualMotion([], onFinish);
  let animation: Animation;
  try { animation = node.animate(frames, timing); } catch { return watchVisualMotion([], onFinish); }
  return watchVisualMotion([animation], onFinish, { durationMs: typeof timing.duration === 'number' ? timing.duration : 200 });
}

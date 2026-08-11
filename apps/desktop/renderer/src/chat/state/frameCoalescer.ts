export interface FrameScheduler {
  request(callback: () => void): number;
  cancel(frameId: number): void;
}

/**
 * Keeps high-frequency UI events to at most one unit of work per animation frame.
 * The latest callback wins so the flush observes the newest event state.
 */
export function createFrameCoalescer(scheduler: FrameScheduler) {
  let frameId: number | null = null;
  let pending: (() => void) | null = null;

  return {
    request(callback: () => void): void {
      pending = callback;
      if (frameId !== null) return;
      frameId = scheduler.request(() => {
        frameId = null;
        const task = pending;
        pending = null;
        task?.();
      });
    },
    /**
     * Runs the queued callback synchronously, canceling the scheduled frame.
     * Use when the work must be reflected before the next paint (e.g. keeping a
     * virtual list spacer in sync with content that is about to render).
     */
    flush(): void {
      if (frameId !== null) {
        scheduler.cancel(frameId);
        frameId = null;
      }
      const task = pending;
      pending = null;
      task?.();
    },
    cancel(): void {
      if (frameId !== null) scheduler.cancel(frameId);
      frameId = null;
      pending = null;
    },
  };
}

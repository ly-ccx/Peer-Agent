export interface CoalescedRefreshScheduler {
  readonly schedule: (delay?: number) => void;
  readonly dispose: () => void;
}

/** Debounces refresh signals and guarantees that an async refresh never overlaps itself. */
export function createCoalescedRefreshScheduler(
  refresh: () => Promise<void>,
  defaultDelay = 100,
): CoalescedRefreshScheduler {
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let queued = false;

  const run = async () => {
    if (running) {
      queued = true;
      return;
    }
    running = true;
    try {
      await refresh();
    } catch {
      // Refreshes update supplementary UI and are retried by the next relevant event.
    } finally {
      running = false;
      if (queued && !disposed) {
        queued = false;
        schedule(defaultDelay);
      }
    }
  };

  const schedule = (delay = defaultDelay) => {
    if (disposed) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void run();
    }, delay);
  };

  return {
    schedule,
    dispose() {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      queued = false;
    },
  };
}

/** Coalesce notifications without losing a fact change that arrives during a read. */
export function createConversationRefresh(read: () => Promise<void>, { delayMs = 0 } = {}) {
  let stopped = false;
  let pending = false;
  let running: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let releaseDelay: (() => void) | null = null;
  const delay = () => delayMs > 0 ? new Promise<void>(resolve => {
    releaseDelay = resolve;
    timer = setTimeout(() => { timer = null; releaseDelay = null; resolve(); }, delayMs);
  }) : Promise.resolve();
  const request = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    pending = true;
    if (running) return running;
    running = (async () => {
      try {
        while (pending && !stopped) {
          if (delayMs > 0) await delay();
          if (stopped) break;
          pending = false;
          await read();
        }
      } finally {
        running = null;
      }
    })();
    return running;
  };
  return { request, stop: () => {
    stopped = true; pending = false;
    if (timer !== null) clearTimeout(timer);
    timer = null; releaseDelay?.(); releaseDelay = null;
  } };
}

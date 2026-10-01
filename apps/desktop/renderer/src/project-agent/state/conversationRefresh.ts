/** Coalesce notifications without losing a fact change that arrives during a read. */
export function createConversationRefresh(read: () => Promise<void>) {
  let stopped = false;
  let pending = false;
  let running: Promise<void> | null = null;
  const request = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    pending = true;
    if (running) return running;
    running = (async () => {
      try {
        while (pending && !stopped) {
          pending = false;
          await read();
        }
      } finally {
        running = null;
      }
    })();
    return running;
  };
  return { request, stop: () => { stopped = true; pending = false; } };
}

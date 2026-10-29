/** Scheduling only; every check still needs its original scoped reader and receipt. */
export function createForegroundRefreshLoop(ports: {
  readonly check: () => Promise<unknown>; readonly foreground: () => boolean;
  readonly schedule: (callback: () => void, delay: number) => unknown; readonly cancel: (timer: unknown) => void;
  readonly interval?: number;
}) {
  let enabled = false, busy = false, timer: unknown = null;
  const clear = () => { if (timer !== null) ports.cancel(timer); timer = null; };
  const arm = (delay: number) => { clear(); if (enabled && ports.foreground()) timer = ports.schedule(() => { timer = null; void run(); }, delay); };
  const run = async () => {
    if (!enabled || !ports.foreground()) return;
    if (busy) { arm(ports.interval ?? 5000); return; }
    busy = true;
    try { await ports.check(); } catch { /* The local reader owns its real failure feedback. */ }
    finally { busy = false; arm(ports.interval ?? 5000); }
  };
  return { start() { enabled = true; arm(ports.interval ?? 5000); }, wake() { if (enabled) arm(0); }, stop() { enabled = false; clear(); } };
}

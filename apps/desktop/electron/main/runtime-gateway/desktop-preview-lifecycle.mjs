/** Preview child lifetime helpers. Isolation still ends on parent close/disconnect. */

export const PREVIEW_IDLE_MS = 10 * 60 * 1000;
export const PREVIEW_KEEPALIVE_MS = 4 * 60 * 1000;

/** Parent pings an open preview so child idle cannot expire before independent review. */
export function createPreviewKeepAlive(send, {
  intervalMs = PREVIEW_KEEPALIVE_MS,
  setTimer = setInterval,
  clearTimer = clearInterval,
} = {}) {
  if (typeof send !== 'function') throw new Error('preview-keepalive-send-missing');
  let timer = null;
  function stop() {
    if (timer != null) clearTimer(timer);
    timer = null;
  }
  function start() {
    stop();
    timer = setTimer(() => { send(); }, intervalMs);
    timer?.unref?.();
  }
  start();
  return { start, stop };
}

export function previewSessionIsOpen(session) {
  const child = session?.child;
  return Boolean(child
    && child.exitCode == null
    && child.signalCode == null
    && child.connected === true);
}

export function createPreviewIdleWatch(exit, {
  idleMs = PREVIEW_IDLE_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (typeof exit !== 'function') throw new Error('preview-idle-exit-missing');
  let timer = null;
  function disarm() {
    if (timer != null) clearTimer(timer);
    timer = null;
  }
  function arm() {
    disarm();
    timer = setTimer(() => { timer = null; exit(); }, idleMs);
    timer?.unref?.();
  }
  arm();
  return { arm, disarm };
}

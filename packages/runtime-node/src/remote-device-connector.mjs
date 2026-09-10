import { connectRemoteDevice } from './remote-device-connection.mjs';

/** Local connection supervisor, not a daemon or task scheduler.
 * No request replay: only connections retry. Unknown/security failures stop closed.
 * connect/schedule are host test seams, never remotely supplied options.
 */
export function startRemoteDeviceConnector(options, {
  connect = connectRemoteDevice,
  schedule = (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref?.(); return () => clearTimeout(timer); },
  random = Math.random,
} = {}) {
  let stopped = false; let active; let cancelRetry; let attempts = 0;
  let resolveClosed;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  function stop(reason = 'stopped') {
    if (stopped) return;
    stopped = true; cancelRetry?.(); cancelRetry = undefined;
    const connection = active; active = undefined;
    try { connection?.stop(); } finally { resolveClosed({ reason }); }
  }
  function retry(reason, wasOnline) {
    if (stopped) return;
    // Before the server has authenticated, transport failures can include TLS or
    // authentication failures. Do not loop indefinitely with unknown credentials.
    const permitted = reason === 'reconnect' || reason === 'network_unavailable'
      || (wasOnline && ['disconnected', 'timeout', 'transport_failure', 'send_failure'].includes(reason));
    if (!permitted) return stop(reason);
    const sample = random();
    if (!Number.isFinite(sample) || sample < 0 || sample > 1) return stop('invalid_retry_clock');
    const delay = reason === 'reconnect' ? 0 : Math.min(30_000, 1000 * 2 ** Math.min(attempts++, 5)) * (0.5 + sample * 0.5);
    cancelRetry = schedule(() => { cancelRetry = undefined; launch(); }, delay);
  }
  function launch() {
    if (stopped) return;
    let online = false;
    try {
      if (options.store.load()?.disabled) return stop('disabled');
      const connection = connect({ ...options, onState(event) {
        if (stopped) return;
        if (event.status === 'online') { online = true; attempts = 0; }
        options.onState?.(event);
      } });
      if (stopped) { connection.stop(); return; }
      active = connection;
      connection.closed.then(({ reason }) => {
        if (active !== connection || stopped) return;
        active = undefined;
        retry(reason, online);
      }).catch(() => stop('connection_failure'));
    } catch { stop('local_failure'); }
  }
  launch();
  return { closed, stop: () => stop() };
}

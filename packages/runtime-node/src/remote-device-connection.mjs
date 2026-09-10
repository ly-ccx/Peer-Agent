import { createRemoteDeviceHandshake } from './remote-device-handshake.mjs';
import { WebSocket } from 'ws';

/** One outbound connection. The caller owns retry policy and credential-vault signing.
 * socketFactory is a host transport seam, never remote configuration. Default is WSS
 * with platform certificate validation. No tool dispatch or hidden auth bypass.
 */
export function connectRemoteDevice({ origin, store, sign, publicKey, name, deviceId,
  onState = () => {}, socketFactory = url => new WebSocket(url), now = Date.now }) {
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.origin !== origin) throw new Error('INVALID_ORIGIN');
  const binding = store.load();
  if (binding?.disabled) throw new Error('REMOTE_DISABLED');
  if (binding && binding.origin !== origin) throw new Error('BINDING_CONFLICT');
  url.protocol = 'wss:'; url.pathname = '/api/device/ws';
  const socket = socketFactory(url.href);
  let stopped = false; let state = 'connecting'; let queued = 0;
  let deadline = now() + 10_000; let poll; let chain = Promise.resolve();
  let resolveClosed;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  const notify = value => { state = value.status; onState(value); };
  const stop = (reason = 'stopped') => {
    if (stopped) return;
    stopped = true; clearInterval(watchdog); clearTimeout(poll);
    try { socket.close(); } finally { resolveClosed({ reason }); }
  };
  const send = message => {
    if (stopped || socket.readyState !== 1 || store.load()?.disabled) throw new Error('CONNECTION_STOPPED');
    socket.send(JSON.stringify(message));
  };
  const handshake = createRemoteDeviceHandshake({ origin, store, sign, publicKey, name, deviceId, now, send });
  const watchdog = setInterval(() => {
    try {
      if (store.load()?.disabled) return stop('disabled');
      if (now() >= deadline) return stop('timeout');
    } catch { stop('local_failure'); }
  }, 1000);
  watchdog.unref?.();
  function schedule(message, delay) {
    clearTimeout(poll);
    poll = setTimeout(() => { try { send(message); } catch { stop('send_failure'); } }, delay);
    poll.unref?.();
  }
  socket.addEventListener('open', () => {
    try { if (!stopped) handshake.start(); } catch { stop('handshake_failure'); }
  });
  socket.addEventListener('message', event => {
    if (stopped) return;
    if (typeof event.data !== 'string' || Buffer.byteLength(event.data) > 4096 || ++queued > 16) {
      stop('invalid_frame'); return;
    }
    chain = chain.then(async () => {
      if (stopped) return;
      const message = JSON.parse(event.data);
      if (state === 'online') {
        if (!message || message.type !== 'remote.heartbeat' || Object.keys(message).length !== 1) throw new Error('INVALID_MESSAGE');
        deadline = now() + 60_000;
        schedule({ type: 'remote.heartbeat' }, 20_000);
        return;
      }
      const result = await handshake.receive(message);
      if (stopped) return;
      if (result.status === 'pairing') {
        deadline = Math.min(result.pairing.expiresAt, now() + 300_000);
        notify(result); schedule({ type: 'remote.binding.query' }, 1000);
      } else if (result.status === 'pending') {
        schedule({ type: 'remote.binding.query' }, 1000);
      } else if (result.status === 'online') {
        deadline = now() + 60_000; notify(result);
        schedule({ type: 'remote.heartbeat' }, 20_000);
      } else if (result.status === 'reconnect') {
        notify(result); stop('reconnect');
      } else notify(result);
    }).catch(() => stop('protocol_failure')).finally(() => { queued--; });
  });
  socket.addEventListener('error', event => {
    // Only structured local transport codes authorize pre-auth retries. Never parse
    // remote error text; certificate and unknown failures remain fail-closed.
    const error = event.error;
    const code = error?.code ?? error?.cause?.code;
    const transient = ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN'].includes(code);
    stop(transient ? 'network_unavailable' : 'transport_failure');
  });
  socket.addEventListener('close', () => stop('disconnected'));
  return { closed, stop: () => stop('stopped') };
}

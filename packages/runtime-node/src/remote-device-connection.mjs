import { createRemoteDeviceHandshake } from './remote-device-handshake.mjs';
import { WebSocket } from 'ws';

/** Answers stay under the 4KiB frame limit both ends enforce. Anything larger is
 * refused rather than truncated: a truncated read result would be a lie. */
const RESULT_MAX_BYTES = 3072;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const exactKeys = (value, fields) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...fields].sort().join(',');

/** One outbound connection. The caller owns retry policy and credential-vault signing.
 * socketFactory is a host transport seam, never remote configuration. Default is WSS
 * with platform certificate validation. No tool dispatch or hidden auth bypass.
 * `delegation` is this machine's grant projection for the Gateway to address reads
 * with; it is never authority, and every incoming request is re-checked locally.
 */
export function connectRemoteDevice({ origin, store, sign, publicKey, name, deviceId,
  delegation = null, onTaskRead = null,
  onState = () => {}, socketFactory = url => new WebSocket(url), now = Date.now }) {
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.origin !== origin) throw new Error('INVALID_ORIGIN');
  const binding = store.load();
  if (binding?.disabled) throw new Error('REMOTE_DISABLED');
  if (binding && binding.origin !== origin) throw new Error('BINDING_CONFLICT');
  // Local configuration errors must surface before a socket exists.
  if (delegation !== null && !delegationShape(delegation)) throw new Error('INVALID_DELEGATION');
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
  /** Shape of the projection published for this connection; checked before send. */
  function delegationShape(value) {
    return exactKeys(value, ['version', 'workspaceIds', 'allowTaskRead', 'allowResultExport', 'expiresAt'])
      && Number.isSafeInteger(value.version) && value.version > 0
      && Array.isArray(value.workspaceIds) && value.workspaceIds.length > 0
      && value.workspaceIds.length <= 32 && value.workspaceIds.every(entry => IDENTIFIER.test(entry))
      && typeof value.allowTaskRead === 'boolean' && typeof value.allowResultExport === 'boolean'
      && Number.isSafeInteger(value.expiresAt) && value.expiresAt > now();
  }
  /** Frame one answer to a read request. Only the handler may grant anything:
   * this function checks shape, bounds the answer and never invents a result. */
  async function answerTaskRequest(message) {
    const requestId = message?.request?.requestId;
    if (!exactKeys(message, ['type', 'protocolVersion', 'request'])
        || !message.request || typeof message.request !== 'object' || Array.isArray(message.request)
        || typeof requestId !== 'string' || !IDENTIFIER.test(requestId)) throw new Error('INVALID_MESSAGE');
    let outcome;
    try {
      outcome = typeof onTaskRead === 'function'
        ? await onTaskRead(message.request)
        : { status: 'failed', code: 'CAPABILITY_DENIED' };
    } catch { outcome = { status: 'failed', code: 'LOCAL_STATE_UNAVAILABLE' }; }
    const code = typeof outcome?.code === 'string' && IDENTIFIER.test(outcome.code)
      ? outcome.code : 'LOCAL_STATE_UNAVAILABLE';
    const answer = outcome?.status === 'ok'
      ? { type: 'remote.task.result', protocolVersion: 1, requestId, status: 'ok', result: outcome.result ?? null }
      : { type: 'remote.task.result', protocolVersion: 1, requestId,
          status: outcome?.status === 'rejected' ? 'rejected' : 'failed', code };
    try {
      if (Buffer.byteLength(JSON.stringify(answer)) > RESULT_MAX_BYTES) {
        send({ type: 'remote.task.result', protocolVersion: 1, requestId, status: 'failed', code: 'RESULT_TOO_LARGE' });
        return;
      }
      send(answer);
    } catch { stop('send_failure'); }
  }
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
        if (exactKeys(message, ['type']) && message.type === 'remote.heartbeat') {
          deadline = now() + 60_000;
          schedule({ type: 'remote.heartbeat' }, 20_000);
          return;
        }
        // Read-only task dispatch. Heartbeats stay on their own timer, so a slow
        // handler delays this chain but never stops the lease from refreshing.
        if (message?.type === 'remote.task.request' && message.protocolVersion === 1) {
          await answerTaskRequest(message);
          return;
        }
        throw new Error('INVALID_MESSAGE');
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
        // Publish the grant projection once per connection: the Gateway needs it
        // to address a read at all, and it must not outlive this socket.
        if (delegation) {
          try { send({ type: 'remote.delegation', protocolVersion: 1, ...delegation }); }
          catch { stop('send_failure'); return; }
        }
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

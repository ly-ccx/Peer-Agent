import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

export const PEER_CORE_PROTOCOL_VERSION = 1;
export const PEER_CORE_MAX_FRAME_BYTES = 2 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 2_000;
const FORCE_KILL_GRACE_MS = 1_000;
const DEFAULT_MAX_RESTARTS = 3;
const MAX_STDERR_LINE_BYTES = 16 * 1024;

export function isPeerCoreClassicEnabled(env = process.env) {
  return env?.PEER_CORE_CLASSIC === '1' || env?.PEER_CORE_ENGINE === 'rust';
}

export function peerCoreBinaryFilename(platform = process.platform) {
  return platform === 'win32' ? 'peer-native.exe' : 'peer-native';
}

export function resolvePeerCoreBinaryPath({
  explicitPath,
  resourcesPath,
  executablePath,
  repositoryRoot,
  platform = process.platform,
  buildProfile = 'debug',
} = {}) {
  const filename = peerCoreBinaryFilename(platform);
  const envPath = process.env.PEER_CORE_BINARY_PATH?.trim();
  const candidates = [
    explicitPath?.trim(),
    envPath,
    resourcesPath ? path.join(resourcesPath, 'bin', filename) : undefined,
    resourcesPath ? path.join(resourcesPath, filename) : undefined,
    executablePath ? path.join(path.dirname(executablePath), filename) : undefined,
    repositoryRoot ? path.join(repositoryRoot, 'target', buildProfile, filename) : undefined,
    repositoryRoot ? path.join(repositoryRoot, 'target', 'release', filename) : undefined,
  ].filter((candidate, index, list) => Boolean(candidate) && list.indexOf(candidate) === index);

  const resolved = candidates.find((candidate) => existsSync(candidate));
  if (!resolved) {
    const error = new Error(
      `Peer Core native binary (${filename}) not found. Searched: ${candidates.join(', ') || '(none)'}`,
    );
    error.code = 'peer_core_binary_not_found';
    throw error;
  }
  return resolved;
}

export function createPeerCoreClient(options = {}) {
  const {
    binaryPath = null,
    resolveBinaryPath = null,
    dataHome = null,
    clientInfo = { name: 'peer-desktop', version: '0.0.0' },
    externalCapabilities = [],
    onNotification = null,
    hostHandlers = {},
    onUnexpectedExit = null,
    logger = console,
    spawnImpl = spawn,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    shutdownTimeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
    maxRestarts = DEFAULT_MAX_RESTARTS,
  } = options;

  let state = 'idle'; // 'idle' | 'starting' | 'ready' | 'exited' | 'disposing' | 'disposed'
  let child = null;
  let childGeneration = 0;
  let startPromise = null;
  let disposePromise = null;
  let nextId = 1;
  let serverVersion = null;
  let registeredExternalCapabilities = [];
  let restartCount = 0;
  let exitWaiters = [];

  const pending = new Map();

  function defaultHostHandlers() {
    return {
      'host.ping': () => ({ ok: true, surface: 'desktop' }),
      ...hostHandlers,
    };
  }

  function resolveBinary() {
    if (typeof binaryPath === 'string' && binaryPath.trim()) {
      return binaryPath.trim();
    }
    if (typeof resolveBinaryPath === 'function') {
      return resolveBinaryPath();
    }
    return resolvePeerCoreBinaryPath(options);
  }

  function rejectAllPending(reason) {
    for (const [, entry] of pending.entries()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    pending.clear();
  }

  function resolveExitWaiters() {
    const waiters = exitWaiters;
    exitWaiters = [];
    for (const resolve of waiters) resolve();
  }

  function writeFrame(targetChild, message) {
    if (!targetChild?.stdin || targetChild.stdin.destroyed || !targetChild.stdin.writable) {
      return Promise.reject(new Error('peer_core_stdin_unavailable'));
    }
    let payload;
    try {
      payload = `${JSON.stringify(message)}\n`;
    } catch (error) {
      return Promise.reject(error);
    }
    if (Buffer.byteLength(payload, 'utf8') - 1 > PEER_CORE_MAX_FRAME_BYTES) {
      return Promise.reject(new Error('peer_core_outbound_frame_too_large'));
    }
    return new Promise((resolve, reject) => {
      targetChild.stdin.write(payload, 'utf8', (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  function sendRequestOnChild(targetChild, method, params = {}, { timeoutMs = requestTimeoutMs } = {}) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Peer Core RPC timeout for ${method} (${timeoutMs}ms)`));
      }, timeoutMs);
      timer.unref?.();

      pending.set(id, { resolve, reject, timer, method });
      writeFrame(targetChild, {
        jsonrpc: '2.0',
        id,
        method,
        params,
      }).catch((error) => {
        if (pending.delete(id)) {
          clearTimeout(timer);
          reject(error);
        }
      });
    });
  }

  async function dispatchHostRequest(targetChild, generation, msg) {
    const { id, method, params } = msg;
    const handlers = defaultHostHandlers();
    const handler = Object.hasOwn(handlers, method) ? handlers[method] : null;
    if (typeof handler !== 'function') {
      if (generation === childGeneration && state !== 'disposed') {
        await writeFrame(targetChild, {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Host method not found: ${method}` },
        }).catch(() => {});
      }
      return;
    }

    try {
      const result = await handler(params ?? {});
      if (generation === childGeneration && state !== 'disposed') {
        await writeFrame(targetChild, {
          jsonrpc: '2.0',
          id,
          result: result ?? null,
        }).catch(() => {});
      }
    } catch (error) {
      const code = Number.isInteger(error?.rpcCode) ? error.rpcCode : -32004;
      const message = error instanceof Error ? error.message : String(error);
      if (generation === childGeneration && state !== 'disposed') {
        await writeFrame(targetChild, {
          jsonrpc: '2.0',
          id,
          error: { code, message },
        }).catch(() => {});
      }
    }
  }

  function handleInboundMessage(targetChild, generation, rawLine) {
    let msg;
    try {
      msg = JSON.parse(rawLine);
    } catch (error) {
      logger?.warn?.('[peer-core] ignoring malformed JSON frame from core:', error?.message || error);
      return;
    }
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') {
      return;
    }
    if (!Object.hasOwn(msg, 'method')) {
      const waiter = pending.get(msg.id);
      if (!waiter) return;
      pending.delete(msg.id);
      clearTimeout(waiter.timer);
      if (msg.error) {
        const rpcError = new Error(msg.error.message || `Peer Core RPC error (${waiter.method})`);
        rpcError.code = msg.error.code;
        rpcError.data = msg.error.data;
        waiter.reject(rpcError);
      } else {
        waiter.resolve(msg.result);
      }
      return;
    }

    if (typeof msg.method !== 'string') return;
    if (Object.hasOwn(msg, 'id')) {
      void dispatchHostRequest(targetChild, generation, msg);
      return;
    }
    try {
      onNotification?.(msg.method, msg.params);
    } catch (error) {
      logger?.warn?.('[peer-core] notification handler threw:', error?.message || error);
    }
  }

  function attachChildStreams(spawned, generation) {
    let stdoutChunks = [];
    let stdoutBytes = 0;

    function flushOverflow(err) {
      logger?.error?.('[peer-core] protocol framing violation:', err.message);
      rejectAllPending(err.message);
      try {
        spawned.kill('SIGTERM');
      } catch {
        // Ignore errors killing already-exited child.
      }
    }

    spawned.stdout?.on('data', (chunk) => {
      if (generation !== childGeneration) return;
      let offset = 0;
      while (offset < chunk.length) {
        const nl = chunk.indexOf(0x0a, offset);
        if (nl === -1) {
          const tail = offset === 0 ? chunk : chunk.subarray(offset);
          if (stdoutBytes + tail.length > PEER_CORE_MAX_FRAME_BYTES) {
            stdoutChunks = [];
            stdoutBytes = 0;
            flushOverflow(new Error('Peer Core outbound frame exceeded max limit'));
            return;
          }
          stdoutChunks.push(tail);
          stdoutBytes += tail.length;
          break;
        }
        const piece = chunk.subarray(offset, nl);
        if (stdoutBytes + piece.length > PEER_CORE_MAX_FRAME_BYTES) {
          stdoutChunks = [];
          stdoutBytes = 0;
          flushOverflow(new Error('Peer Core outbound frame exceeded max limit'));
          return;
        }
        const fullBuf = stdoutChunks.length > 0
          ? Buffer.concat([...stdoutChunks, piece], stdoutBytes + piece.length)
          : piece;
        stdoutChunks = [];
        stdoutBytes = 0;
        const line = fullBuf.toString('utf8').replace(/\r$/, '');
        if (line.trim() !== '') {
          handleInboundMessage(spawned, generation, line);
        }
        offset = nl + 1;
      }
    });

    let stderrCarry = '';
    spawned.stderr?.on('data', (chunk) => {
      if (generation !== childGeneration) return;
      stderrCarry += chunk.toString('utf8');
      if (stderrCarry.length > MAX_STDERR_LINE_BYTES * 2) {
        stderrCarry = stderrCarry.slice(-MAX_STDERR_LINE_BYTES);
      }
      let nl;
      while ((nl = stderrCarry.indexOf('\n')) !== -1) {
        const line = stderrCarry.slice(0, nl).trim();
        stderrCarry = stderrCarry.slice(nl + 1);
        if (line) {
          logger?.warn?.('[peer-core:stderr]', line);
        }
      }
    });

    spawned.stdin?.on('error', (error) => {
      if (generation === childGeneration && state !== 'disposing' && state !== 'disposed') {
        logger?.warn?.('[peer-core] stdin error:', error?.message || error);
      }
    });

    let finalized = false;
    const finalizeChild = (code, signal, error = null) => {
      if (finalized) return;
      finalized = true;
      resolveExitWaiters();
      if (generation !== childGeneration) return;

      const unexpected = state !== 'disposing' && state !== 'disposed';
      const detail = error
        ? `Peer Core process error: ${error.message}`
        : `Peer Core process exited (${code ?? signal ?? 'unknown'})`;
      rejectAllPending(detail);
      if (child === spawned) {
        child = null;
      }
      if (unexpected) {
        state = 'exited';
        try {
          onUnexpectedExit?.({ code, signal, error, restartCount });
        } catch (cbErr) {
          logger?.warn?.('[peer-core] onUnexpectedExit handler threw:', cbErr?.message || cbErr);
        }
      }
    };

    spawned.on('error', (error) => finalizeChild(null, null, error));
    spawned.on('exit', (code, signal) => finalizeChild(code, signal, null));
  }

  function isChildAlive(target) {
    return Boolean(target && target.exitCode === null && target.signalCode === null);
  }

  async function spawnAndInitialize() {
    const resolvedBinary = resolveBinary();
    const generation = ++childGeneration;
    const spawned = spawnImpl(resolvedBinary, ['core', '--stdio'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...process.env,
        ...(dataHome ? { PEER_AGENT_HOME: dataHome } : {}),
      },
    });
    child = spawned;
    attachChildStreams(spawned, generation);

    try {
      const initResult = await sendRequestOnChild(spawned, 'core.initialize', {
        protocolVersion: PEER_CORE_PROTOCOL_VERSION,
        client: clientInfo,
        externalCapabilities,
      });
      if (state === 'disposing' || state === 'disposed' || generation !== childGeneration) {
        throw new Error('peer_core_disposed_during_startup');
      }
      serverVersion = initResult?.server?.version ?? null;
      registeredExternalCapabilities = Array.isArray(initResult?.capabilities?.registeredExternalCapabilities)
        ? [...initResult.capabilities.registeredExternalCapabilities]
        : [];
      state = 'ready';
      return initResult;
    } catch (error) {
      if (generation === childGeneration && state !== 'disposing' && state !== 'disposed') {
        state = 'exited';
        if (child === spawned) {
          child = null;
        }
      }
      try {
        if (isChildAlive(spawned)) spawned.kill('SIGTERM');
      } catch {
        // Ignore cleanup kill failures.
      }
      throw error;
    }
  }

  async function start() {
    if (state === 'disposing' || state === 'disposed') {
      throw new Error('peer_core_disposed');
    }
    if (state === 'ready' && isChildAlive(child)) {
      return {
        protocolVersion: PEER_CORE_PROTOCOL_VERSION,
        server: { name: 'peer-core', version: serverVersion },
        pid: child.pid,
        capabilities: { registeredExternalCapabilities: [...registeredExternalCapabilities] },
      };
    }
    if (startPromise) return startPromise;

    state = 'starting';
    startPromise = spawnAndInitialize().finally(() => {
      startPromise = null;
    });
    return startPromise;
  }

  async function ensureStarted() {
    if (state === 'disposing' || state === 'disposed') {
      throw new Error('peer_core_disposed');
    }
    if (startPromise) {
      await startPromise;
      return status();
    }
    if (state === 'ready' && !isChildAlive(child)) {
      state = 'exited';
      child = null;
    }
    if (state === 'ready') {
      return status();
    }
    if (state === 'exited') {
      if (restartCount >= maxRestarts) {
        throw new Error(`peer_core_restart_limit_exceeded (${maxRestarts})`);
      }
      restartCount += 1;
    }
    await start();
    return status();
  }

  function request(method, params = {}, optionsArg = {}) {
    if (state !== 'ready' || !isChildAlive(child)) {
      return Promise.reject(new Error(`Peer Core client is not ready (state=${state})`));
    }
    return sendRequestOnChild(child, method, params, optionsArg);
  }

  function notify(method, params = {}) {
    if (state !== 'ready' || !isChildAlive(child)) {
      return Promise.reject(new Error(`Peer Core client is not ready (state=${state})`));
    }
    return writeFrame(child, {
      jsonrpc: '2.0',
      method,
      params,
    });
  }

  async function ping({ probeHost = false } = {}) {
    await ensureStarted();
    return request('core.ping', { probeHost });
  }

  async function listCapabilities() {
    await ensureStarted();
    return request('core.capabilities.list', {});
  }

  function status() {
    return {
      state,
      pid: isChildAlive(child) ? (child.pid ?? null) : null,
      protocolVersion: PEER_CORE_PROTOCOL_VERSION,
      serverVersion,
      restartCount,
      registeredExternalCapabilities: [...registeredExternalCapabilities],
    };
  }

  function waitForChildExit(targetChild, timeoutMs) {
    if (!isChildAlive(targetChild)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve(!isChildAlive(targetChild));
      }, timeoutMs);
      timer.unref?.();
      exitWaiters.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  async function dispose() {
    if (state === 'disposed') return false;
    if (disposePromise) return disposePromise;

    disposePromise = (async () => {
      state = 'disposing';
      if (startPromise) {
        try {
          await startPromise;
        } catch {
          // Startup failures clean up themselves.
        }
      }
      const targetChild = child;
      if (targetChild && isChildAlive(targetChild)) {
        try {
          await sendRequestOnChild(targetChild, 'core.shutdown', {}, {
            timeoutMs: shutdownTimeoutMs,
          });
        } catch {
          // Proceed with stdin close + signal escalation if clean shutdown fails.
        }
        try {
          targetChild.stdin?.end();
        } catch {
          // Ignore stdin end failures.
        }
        const exitedCleanly = await waitForChildExit(targetChild, shutdownTimeoutMs);
        if (!exitedCleanly && isChildAlive(targetChild)) {
          try {
            targetChild.kill('SIGTERM');
          } catch {
            // Ignore SIGTERM failure.
          }
          const exitedOnTerm = await waitForChildExit(targetChild, FORCE_KILL_GRACE_MS);
          if (!exitedOnTerm && isChildAlive(targetChild)) {
            try {
              targetChild.kill('SIGKILL');
            } catch {
              // Ignore SIGKILL failure.
            }
            await waitForChildExit(targetChild, FORCE_KILL_GRACE_MS);
          }
        }
      }
      rejectAllPending('Peer Core client disposed');
      child = null;
      state = 'disposed';
      return true;
    })();

    return disposePromise;
  }

  return Object.freeze({
    start,
    ensureStarted,
    ping,
    listCapabilities,
    request,
    notify,
    status,
    dispose,
  });
}

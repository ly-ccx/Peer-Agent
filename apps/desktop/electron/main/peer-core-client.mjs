import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export const PEER_CORE_PROTOCOL_VERSION = 1;
export const PEER_CORE_MAX_FRAME_BYTES = 64 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 2_000;
const FORCE_KILL_GRACE_MS = 1_000;
const DEFAULT_MAX_RESTARTS = 3;
const DEFAULT_DAEMON_READY_TIMEOUT_MS = 5_000;
const DEFAULT_DAEMON_CONNECT_TIMEOUT_MS = 1_500;
const MAX_STDERR_LINE_BYTES = 16 * 1024;

export function isPeerCoreClassicEnabled(env = process.env) {
  const flag = env?.PEER_CORE_CLASSIC?.trim?.().toLowerCase?.();
  const engine = env?.PEER_CORE_ENGINE?.trim?.().toLowerCase?.();
  if (flag === '0' || flag === 'false' || flag === 'off') return false;
  if (engine === 'ts' || engine === 'node' || engine === 'legacy') return false;
  if (flag === '1' || flag === 'true' || flag === 'on' || engine === 'rust') return true;
  return true;
}

export function isPeerCoreDaemonEnabled(env = process.env) {
  const flag = env?.PEER_CORE_DAEMON?.trim?.().toLowerCase?.();
  if (flag === '0' || flag === 'false' || flag === 'off') return false;
  return true;
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

export function resolveEffectivePeerDataHome(dataHome, envObj = null) {
  if (typeof dataHome === 'string' && dataHome.trim()) {
    return path.resolve(dataHome.trim());
  }
  const merged = envObj && typeof envObj === 'object' ? envObj : process.env;
  const override = merged?.PEER_AGENT_HOME?.trim?.() || process.env.PEER_AGENT_HOME?.trim?.();
  if (override) {
    return path.resolve(override);
  }
  const homeDir = merged?.HOME?.trim?.() || merged?.USERPROFILE?.trim?.() || os.homedir();
  return path.join(homeDir, '.peer-agent');
}

export function readPeerCoreDaemonDescriptor(dataHome) {
  if (typeof dataHome !== 'string' || !dataHome.trim()) return null;
  const descPath = path.join(dataHome, 'core-daemon.json');
  try {
    const raw = JSON.parse(readFileSync(descPath, 'utf8'));
    if (
      !raw
      || raw.version !== 1
      || typeof raw.endpoint !== 'string'
      || !raw.endpoint.trim()
      || typeof raw.authToken !== 'string'
      || !raw.authToken.trim()
      || !Number.isInteger(raw.pid)
      || raw.pid <= 0
    ) {
      return null;
    }
    return raw;
  } catch {
    return null;
  }
}

function attachLineReader(stream, { isActive, onLine, onOverflow }) {
  let chunks = [];
  let bytes = 0;

  stream?.on('data', (chunk) => {
    if (!isActive()) return;
    let offset = 0;
    while (offset < chunk.length) {
      const nl = chunk.indexOf(0x0a, offset);
      if (nl === -1) {
        const tail = offset === 0 ? chunk : chunk.subarray(offset);
        if (bytes + tail.length > PEER_CORE_MAX_FRAME_BYTES) {
          chunks = [];
          bytes = 0;
          onOverflow(new Error('Peer Core outbound frame exceeded max limit'));
          return;
        }
        chunks.push(tail);
        bytes += tail.length;
        break;
      }
      const piece = chunk.subarray(offset, nl);
      if (bytes + piece.length > PEER_CORE_MAX_FRAME_BYTES) {
        chunks = [];
        bytes = 0;
        onOverflow(new Error('Peer Core outbound frame exceeded max limit'));
        return;
      }
      const fullBuf = chunks.length > 0
        ? Buffer.concat([...chunks, piece], bytes + piece.length)
        : piece;
      chunks = [];
      bytes = 0;
      const line = fullBuf.toString('utf8').replace(/\r$/, '');
      if (line.trim() !== '') {
        onLine(line);
      }
      offset = nl + 1;
    }
  });
}

export function createPeerCoreClient(options = {}) {
  const {
    binaryPath = null,
    resolveBinaryPath = null,
    dataHome = null,
    env = null,
    transport = 'stdio',
    fallbackToStdio = false,
    shutdownDaemonOnDispose = false,
    clientInfo = { name: 'peer-desktop', version: '0.0.0' },
    externalCapabilities = [],
    onNotification = null,
    hostHandlers = {},
    onUnexpectedExit = null,
    logger = console,
    spawnImpl = spawn,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    shutdownTimeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
    daemonReadyTimeoutMs = DEFAULT_DAEMON_READY_TIMEOUT_MS,
    daemonConnectTimeoutMs = DEFAULT_DAEMON_CONNECT_TIMEOUT_MS,
    maxRestarts = DEFAULT_MAX_RESTARTS,
  } = options;

  let state = 'idle'; // 'idle' | 'starting' | 'ready' | 'exited' | 'disposing' | 'disposed'
  let channel = null; // { kind: 'stdio' | 'daemon', generation, writeStream, child?, socket?, endpoint?, descriptor? }
  let activeTransport = transport === 'daemon' ? 'daemon' : 'stdio';
  let activeEndpoint = null;
  let ownedDaemon = false;
  let activePid = null;
  let childGeneration = 0;
  let startPromise = null;
  let disposePromise = null;
  let nextId = 1;
  let serverVersion = null;
  let registeredExternalCapabilities = [];
  let restartCount = 0;
  let exitWaiters = [];
  let healthProbeGeneration = null;

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

  function buildSpawnEnv() {
    return {
      ...process.env,
      ...(env && typeof env === 'object' ? env : {}),
      ...(dataHome ? { PEER_AGENT_HOME: dataHome } : {}),
    };
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

  function isChildAlive(target) {
    return Boolean(target && target.exitCode === null && target.signalCode === null);
  }

  function isSocketAlive(targetSocket) {
    return Boolean(targetSocket && !targetSocket.destroyed && targetSocket.writable);
  }

  function isChannelAlive(target = channel) {
    if (!target) return false;
    return target.kind === 'daemon'
      ? isSocketAlive(target.socket)
      : isChildAlive(target.child);
  }

  function writeFrame(targetChannel, message) {
    const stream = targetChannel?.writeStream;
    if (!stream || stream.destroyed || !stream.writable) {
      return Promise.reject(new Error('peer_core_write_stream_unavailable'));
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
      stream.write(payload, 'utf8', (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  function probeDaemonChannelHealth(targetChannel) {
    if (
      !targetChannel
      || targetChannel.kind !== 'daemon'
      || targetChannel !== channel
      || state !== 'ready'
      || healthProbeGeneration === targetChannel.generation
    ) {
      return;
    }
    healthProbeGeneration = targetChannel.generation;
    sendRequestOnChannel(targetChannel, 'core.ping', {}, { timeoutMs: 2_500, skipHealthProbe: true })
      .catch(() => {
        if (targetChannel !== channel || state === 'disposing' || state === 'disposed') {
          return;
        }
        logger?.warn?.('[peer-core] daemon socket unresponsive after RPC timeout, resetting connection');
        try {
          targetChannel.socket?.destroy(new Error('Peer Core daemon socket unresponsive after RPC timeout'));
        } catch {
          // Ignore socket destroy failures.
        }
      })
      .finally(() => {
        if (healthProbeGeneration === targetChannel.generation) {
          healthProbeGeneration = null;
        }
      });
  }

  function sendRequestOnChannel(
    targetChannel,
    method,
    params = {},
    { timeoutMs = requestTimeoutMs, skipHealthProbe = false } = {},
  ) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Peer Core RPC timeout for ${method} (${timeoutMs}ms)`));
        if (
          !skipHealthProbe
          && targetChannel?.kind === 'daemon'
          && method !== 'core.ping'
          && method !== 'core.initialize'
          && method !== 'core.shutdown'
        ) {
          probeDaemonChannelHealth(targetChannel);
        }
      }, timeoutMs);
      timer.unref?.();

      pending.set(id, { resolve, reject, timer, method });
      writeFrame(targetChannel, {
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

  async function dispatchHostRequest(targetChannel, generation, msg) {
    const { id, method, params } = msg;
    const handlers = defaultHostHandlers();
    const handler = Object.hasOwn(handlers, method) ? handlers[method] : null;
    if (typeof handler !== 'function') {
      if (generation === childGeneration && state !== 'disposed') {
        await writeFrame(targetChannel, {
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
        await writeFrame(targetChannel, {
          jsonrpc: '2.0',
          id,
          result: result ?? null,
        }).catch(() => {});
      }
    } catch (error) {
      const code = Number.isInteger(error?.rpcCode) ? error.rpcCode : -32004;
      const message = error instanceof Error ? error.message : String(error);
      if (generation === childGeneration && state !== 'disposed') {
        await writeFrame(targetChannel, {
          jsonrpc: '2.0',
          id,
          error: { code, message },
        }).catch(() => {});
      }
    }
  }

  function handleInboundMessage(targetChannel, generation, rawLine) {
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
      if (!waiter) {
        if (msg.error) {
          logger?.warn?.('[peer-core] unmatched JSON-RPC error frame:', msg.error.message || msg.error);
          if (msg.id == null && pending.size === 1) {
            const [[onlyId, onlyWaiter]] = pending.entries();
            pending.delete(onlyId);
            clearTimeout(onlyWaiter.timer);
            const rpcError = new Error(msg.error.message || `Peer Core RPC error (${onlyWaiter.method})`);
            rpcError.code = msg.error.code;
            rpcError.data = msg.error.data;
            onlyWaiter.reject(rpcError);
          }
        }
        return;
      }
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
      void dispatchHostRequest(targetChannel, generation, msg);
      return;
    }
    try {
      onNotification?.(msg.method, msg.params);
    } catch (error) {
      logger?.warn?.('[peer-core] notification handler threw:', error?.message || error);
    }
  }

  function finalizeChannel(targetChannel, generation, { code = null, signal = null, error = null } = {}) {
    resolveExitWaiters();
    if (generation !== childGeneration) return;

    const unexpected = state !== 'disposing' && state !== 'disposed';
    const detail = error
      ? `Peer Core ${targetChannel.kind} error: ${error.message}`
      : `Peer Core ${targetChannel.kind} exited (${code ?? signal ?? 'closed'})`;
    rejectAllPending(detail);
    if (channel === targetChannel) {
      channel = null;
      activePid = null;
    }
    if (unexpected) {
      state = 'exited';
      try {
        onUnexpectedExit?.({ code, signal, error, restartCount, transport: targetChannel.kind });
      } catch (cbErr) {
        logger?.warn?.('[peer-core] onUnexpectedExit handler threw:', cbErr?.message || cbErr);
      }
    }
  }

  function attachChildStreams(targetChannel, generation) {
    const spawned = targetChannel.child;
    attachLineReader(spawned.stdout, {
      isActive: () => generation === childGeneration,
      onLine: (line) => handleInboundMessage(targetChannel, generation, line),
      onOverflow: (err) => {
        logger?.error?.('[peer-core] protocol framing violation:', err.message);
        rejectAllPending(err.message);
        try {
          spawned.kill('SIGTERM');
        } catch {
          // Ignore errors killing already-exited child.
        }
      },
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
    const onDone = (code, signal, error = null) => {
      if (finalized) return;
      finalized = true;
      finalizeChannel(targetChannel, generation, { code, signal, error });
    };

    spawned.on('error', (error) => onDone(null, null, error));
    spawned.on('exit', (code, signal) => onDone(code, signal, null));
  }

  function attachSocketStreams(targetChannel, generation) {
    const socket = targetChannel.socket;
    attachLineReader(socket, {
      isActive: () => generation === childGeneration,
      onLine: (line) => handleInboundMessage(targetChannel, generation, line),
      onOverflow: (err) => {
        logger?.error?.('[peer-core] daemon protocol framing violation:', err.message);
        rejectAllPending(err.message);
        try {
          socket.destroy();
        } catch {
          // Ignore destroy errors.
        }
      },
    });

    let finalized = false;
    let lastError = null;
    const onDone = (error = null) => {
      if (finalized) return;
      finalized = true;
      finalizeChannel(targetChannel, generation, { error: error || lastError });
    };

    socket.on('error', (error) => {
      lastError = error;
      if (generation === childGeneration && state !== 'disposing' && state !== 'disposed') {
        logger?.warn?.('[peer-core] daemon socket error:', error?.message || error);
      }
    });
    socket.on('close', () => onDone(null));
  }

  async function spawnStdioAndInitialize() {
    const resolvedBinary = resolveBinary();
    const generation = ++childGeneration;
    const spawned = spawnImpl(resolvedBinary, ['core', '--stdio'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: buildSpawnEnv(),
    });
    const stdioChannel = {
      kind: 'stdio',
      generation,
      writeStream: spawned.stdin,
      child: spawned,
    };
    channel = stdioChannel;
    activeTransport = 'stdio';
    activeEndpoint = null;
    ownedDaemon = false;
    activePid = spawned.pid ?? null;
    attachChildStreams(stdioChannel, generation);

    try {
      const initResult = await sendRequestOnChannel(stdioChannel, 'core.initialize', {
        protocolVersion: PEER_CORE_PROTOCOL_VERSION,
        client: clientInfo,
        externalCapabilities,
      });
      if (state === 'disposing' || state === 'disposed' || generation !== childGeneration) {
        throw new Error('peer_core_disposed_during_startup');
      }
      serverVersion = initResult?.server?.version ?? null;
      activePid = initResult?.pid ?? spawned.pid ?? null;
      registeredExternalCapabilities = Array.isArray(initResult?.capabilities?.registeredExternalCapabilities)
        ? [...initResult.capabilities.registeredExternalCapabilities]
        : [];
      state = 'ready';
      return initResult;
    } catch (error) {
      if (generation === childGeneration && state !== 'disposing' && state !== 'disposed') {
        state = 'exited';
        if (channel === stdioChannel) {
          channel = null;
          activePid = null;
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

  function connectSocket(endpoint, timeoutMs) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(endpoint);
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(new Error(`Peer Core daemon connect timeout (${timeoutMs}ms)`));
      }, timeoutMs);
      timer.unref?.();

      const onError = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        reject(error);
      };

      socket.once('error', onError);
      socket.once('connect', () => {
        if (settled) {
          socket.destroy();
          return;
        }
        settled = true;
        clearTimeout(timer);
        socket.removeListener('error', onError);
        resolve(socket);
      });
    });
  }

  async function connectToDaemonDescriptor(descriptor, generation, { owned = false } = {}) {
    const socket = await connectSocket(descriptor.endpoint, daemonConnectTimeoutMs);
    const daemonChannel = {
      kind: 'daemon',
      generation,
      writeStream: socket,
      socket,
      endpoint: descriptor.endpoint,
      descriptor,
    };
    channel = daemonChannel;
    activeTransport = 'daemon';
    activeEndpoint = descriptor.endpoint;
    ownedDaemon = owned;
    activePid = descriptor.pid;
    attachSocketStreams(daemonChannel, generation);

    try {
      const initResult = await sendRequestOnChannel(daemonChannel, 'core.initialize', {
        protocolVersion: PEER_CORE_PROTOCOL_VERSION,
        client: clientInfo,
        externalCapabilities,
        authToken: descriptor.authToken,
      });
      if (state === 'disposing' || state === 'disposed' || generation !== childGeneration) {
        throw new Error('peer_core_disposed_during_startup');
      }
      serverVersion = initResult?.server?.version ?? null;
      activePid = initResult?.pid ?? descriptor.pid ?? null;
      registeredExternalCapabilities = Array.isArray(initResult?.capabilities?.registeredExternalCapabilities)
        ? [...initResult.capabilities.registeredExternalCapabilities]
        : [];
      state = 'ready';
      return initResult;
    } catch (error) {
      if (channel === daemonChannel) {
        channel = null;
        activePid = null;
      }
      try {
        socket.destroy();
      } catch {
        // Ignore socket cleanup failures.
      }
      throw error;
    }
  }

  function isNewDescriptor(candidate, previousDescriptor) {
    if (!candidate) return false;
    if (!previousDescriptor) return true;
    return candidate.authToken !== previousDescriptor.authToken || candidate.pid !== previousDescriptor.pid;
  }

  function spawnDaemonAndWait(resolvedBinary, effectiveDataHome, previousDescriptor) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let spawned;
      try {
        spawned = spawnImpl(resolvedBinary, ['core', '--daemon'], {
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          env: {
            ...buildSpawnEnv(),
            PEER_AGENT_HOME: effectiveDataHome,
          },
        });
      } catch (spawnErr) {
        reject(spawnErr);
        return;
      }

      let stderrTail = '';
      let stdoutBuf = '';
      let pollTimer = null;
      const cleanup = () => {
        clearTimeout(timeoutTimer);
        if (pollTimer) clearInterval(pollTimer);
        try {
          spawned.stdout?.removeAllListeners?.();
          spawned.stderr?.removeAllListeners?.();
          spawned.stdout?.destroy?.();
          spawned.stderr?.destroy?.();
        } catch {
          // Ignore stream cleanup failures.
        }
        try {
          spawned.unref?.();
        } catch {
          // Ignore unref failures on custom test spawners.
        }
      };

      const finishResolve = (descriptor) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ descriptor, spawnedPid: spawned.pid ?? descriptor.pid });
      };

      const finishReject = (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };

      const tryCheckDescriptor = () => {
        const candidate = readPeerCoreDaemonDescriptor(effectiveDataHome);
        if (isNewDescriptor(candidate, previousDescriptor)) {
          finishResolve(candidate);
          return true;
        }
        return false;
      };

      const timeoutTimer = setTimeout(() => {
        if (tryCheckDescriptor()) return;
        finishReject(new Error(`Peer Core daemon failed to become ready within ${daemonReadyTimeoutMs}ms${stderrTail ? `: ${stderrTail.trim()}` : ''}`));
      }, daemonReadyTimeoutMs);
      timeoutTimer.unref?.();

      pollTimer = setInterval(() => {
        tryCheckDescriptor();
      }, 30);
      pollTimer.unref?.();

      spawned.stdout?.on('data', (chunk) => {
        stdoutBuf += chunk.toString('utf8');
        const nl = stdoutBuf.indexOf('\n');
        if (nl !== -1) {
          const line = stdoutBuf.slice(0, nl).trim();
          try {
            const parsed = JSON.parse(line);
            if (parsed?.ok && parsed?.daemon) {
              if (!tryCheckDescriptor()) {
                setTimeout(() => tryCheckDescriptor(), 15).unref?.();
              }
            }
          } catch {
            // Non-JSON line; rely on descriptor polling.
          }
        }
      });

      spawned.stderr?.on('data', (chunk) => {
        stderrTail = (stderrTail + chunk.toString('utf8')).slice(-2048);
      });

      spawned.once('error', (error) => {
        finishReject(error);
      });

      spawned.once('exit', (code, signal) => {
        // Another concurrent process may have won startup and written core-daemon.json.
        const candidate = readPeerCoreDaemonDescriptor(effectiveDataHome);
        if (candidate) {
          finishResolve(candidate);
          return;
        }
        finishReject(new Error(
          `Peer Core daemon exited early (${code ?? signal ?? 'unknown'})${stderrTail ? `: ${stderrTail.trim()}` : ''}`,
        ));
      });
    });
  }

  async function spawnDaemonAndInitialize() {
    const generation = ++childGeneration;
    const effectiveDataHome = resolveEffectivePeerDataHome(dataHome, env);
    const existingDescriptor = readPeerCoreDaemonDescriptor(effectiveDataHome);

    if (existingDescriptor) {
      try {
        return await connectToDaemonDescriptor(existingDescriptor, generation, { owned: false });
      } catch (err) {
        if (state === 'disposing' || state === 'disposed' || generation !== childGeneration) {
          throw err;
        }
        logger?.info?.('[peer-core] stale daemon descriptor detected, spawning fresh daemon:', err?.message || err);
      }
    }

    const resolvedBinary = resolveBinary();
    const { descriptor, spawnedPid } = await spawnDaemonAndWait(
      resolvedBinary,
      effectiveDataHome,
      existingDescriptor,
    );
    if (state === 'disposing' || state === 'disposed' || generation !== childGeneration) {
      throw new Error('peer_core_disposed_during_startup');
    }
    return await connectToDaemonDescriptor(descriptor, generation, {
      owned: descriptor.pid === spawnedPid,
    });
  }

  async function startInternal() {
    if (transport === 'daemon') {
      try {
        return await spawnDaemonAndInitialize();
      } catch (daemonErr) {
        if (state === 'disposing' || state === 'disposed' || !fallbackToStdio) {
          if (state !== 'disposing' && state !== 'disposed') {
            state = 'exited';
          }
          throw daemonErr;
        }
        logger?.warn?.('[peer-core] daemon startup failed, falling back to --stdio:', daemonErr?.message || daemonErr);
        return await spawnStdioAndInitialize();
      }
    }
    return await spawnStdioAndInitialize();
  }

  async function start() {
    if (state === 'disposing' || state === 'disposed') {
      throw new Error('peer_core_disposed');
    }
    if (state === 'ready' && isChannelAlive()) {
      return {
        protocolVersion: PEER_CORE_PROTOCOL_VERSION,
        server: { name: 'peer-core', version: serverVersion },
        pid: activePid,
        capabilities: { registeredExternalCapabilities: [...registeredExternalCapabilities] },
      };
    }
    if (startPromise) return startPromise;

    state = 'starting';
    startPromise = startInternal().finally(() => {
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
    if (state === 'ready' && !isChannelAlive()) {
      state = 'exited';
      channel = null;
      activePid = null;
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
    if (state !== 'ready' || !isChannelAlive()) {
      return Promise.reject(new Error(`Peer Core client is not ready (state=${state})`));
    }
    return sendRequestOnChannel(channel, method, params, optionsArg);
  }

  function notify(method, params = {}) {
    if (state !== 'ready' || !isChannelAlive()) {
      return Promise.reject(new Error(`Peer Core client is not ready (state=${state})`));
    }
    return writeFrame(channel, {
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

  function isReady() {
    return state === 'ready' && isChannelAlive();
  }

  function status() {
    const alive = isChannelAlive();
    return {
      state,
      transport: activeTransport,
      endpoint: activeEndpoint,
      ownedDaemon,
      pid: alive ? activePid : null,
      protocolVersion: PEER_CORE_PROTOCOL_VERSION,
      serverVersion,
      restartCount,
      registeredExternalCapabilities: [...registeredExternalCapabilities],
    };
  }

  function waitForExit(timeoutMs, checkGone) {
    if (checkGone()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve(checkGone());
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
      const targetChannel = channel;
      if (targetChannel && isChannelAlive(targetChannel)) {
        if (targetChannel.kind === 'daemon') {
          let shutdownResult = null;
          const shutdownParams = shutdownDaemonOnDispose
            ? { shutdownDaemon: true }
            : { shutdownIfLast: ownedDaemon };
          try {
            shutdownResult = await sendRequestOnChannel(
              targetChannel,
              'core.shutdown',
              shutdownParams,
              { timeoutMs: shutdownTimeoutMs },
            );
          } catch {
            // Ignore shutdown RPC failure during socket teardown.
          }
          try {
            targetChannel.socket.end();
          } catch {
            // Ignore socket end failures.
          }
          if (shutdownResult?.daemonShutdown) {
            await waitForExit(shutdownTimeoutMs, () => targetChannel.socket.destroyed);
            const effectiveDataHome = resolveEffectivePeerDataHome(dataHome, env);
            const expectedToken = targetChannel.descriptor?.authToken;
            const deadline = Date.now() + shutdownTimeoutMs;
            while (Date.now() < deadline) {
              const current = readPeerCoreDaemonDescriptor(effectiveDataHome);
              if (!current || (expectedToken && current.authToken !== expectedToken)) {
                break;
              }
              await new Promise((r) => setTimeout(r, 20));
            }
          }
          try {
            if (!targetChannel.socket.destroyed) {
              targetChannel.socket.destroy();
            }
          } catch {
            // Ignore socket destroy failures.
          }
        } else {
          const targetChild = targetChannel.child;
          try {
            await sendRequestOnChannel(targetChannel, 'core.shutdown', {}, {
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
          const exitedCleanly = await waitForExit(shutdownTimeoutMs, () => !isChildAlive(targetChild));
          if (!exitedCleanly && isChildAlive(targetChild)) {
            try {
              targetChild.kill('SIGTERM');
            } catch {
              // Ignore SIGTERM failure.
            }
            const exitedOnTerm = await waitForExit(FORCE_KILL_GRACE_MS, () => !isChildAlive(targetChild));
            if (!exitedOnTerm && isChildAlive(targetChild)) {
              try {
                targetChild.kill('SIGKILL');
              } catch {
                // Ignore SIGKILL failure.
              }
              await waitForExit(FORCE_KILL_GRACE_MS, () => !isChildAlive(targetChild));
            }
          }
        }
      }
      rejectAllPending('Peer Core client disposed');
      channel = null;
      activePid = null;
      state = 'disposed';
      return true;
    })();

    return disposePromise;
  }

  return Object.freeze({
    start,
    ensureStarted,
    isReady,
    ping,
    listCapabilities,
    request,
    notify,
    status,
    dispose,
  });
}

// 实验台进程归属：停止和清理只认本轮 register() 拿到的句柄。
//
// 事故（知识 38.5）：会话侧用 pgrep 模糊匹配，再取父 PID 发 SIGTERM，打到宿主 1887。
// 本模块把「能不能停」做成显式判定：对不上句柄就拒绝，绝不根据 PID / 父 PID / pgrep 结果发信号。

export const STOP_REFUSED_UNKNOWN_IDENTITY = 'stop-refused-unknown-identity';
export const STOP_REFUSED_PARENT_PID_INFERENCE = 'stop-refused-parent-pid-inference';
export const STOP_REFUSED_FUZZY_SEARCH = 'stop-refused-fuzzy-search';
export const STOP_ALREADY_EXITED = 'stop-already-exited';
export const STOP_CANCELLED = 'stop-cancelled';
export const STOP_TIMEOUT = 'stop-timeout';
export const STOP_OWNED = 'stop-owned';

function isFuzzyStopRequest(request) {
  return Boolean(
    request?.fuzzyMatch
      || request?.via === 'pgrep'
      || request?.via === 'fuzzy-search'
      || Array.isArray(request?.pgrepHits)
      || request?.pgrepHits,
  );
}

function isParentPidInference(request) {
  const hasHandle = typeof request?.handleId === 'string' && request.handleId.length > 0;
  return request?.parentPid != null && !hasHandle;
}

const STOP_WAIT_MS = 15_000;

function processExited(processHandle) {
  if (!processHandle) return false;
  // killed 只表示发过信号，进程可能还活着。38.17 把 close()/kill() 当成已退出，
  // 报告提前写 closed=true。只认真实退出码或 exit 事件留下的 signalCode。
  if (processHandle.exitCode != null) return true;
  if (processHandle.signalCode != null) return true;
  return false;
}

function waitForProcessExit(processHandle, timeoutMs = STOP_WAIT_MS) {
  if (!processHandle) return Promise.resolve(false);
  if (processExited(processHandle)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (typeof processHandle.off === 'function') processHandle.off('exit', onExit);
      else if (typeof processHandle.removeListener === 'function') {
        processHandle.removeListener('exit', onExit);
      }
      resolve(processExited(processHandle));
    };
    const onExit = () => finish();
    const timer = setTimeout(finish, Math.max(0, Number(timeoutMs) || 0));
    if (typeof processHandle.once === 'function') processHandle.once('exit', onExit);
    else finish();
  });
}

export function inspectStopRequest(request = {}, owned = []) {
  if (isFuzzyStopRequest(request)) {
    return {
      ok: false,
      code: STOP_REFUSED_FUZZY_SEARCH,
      signaled: false,
      reason: 'pgrep 或模糊匹配结果不能当作停止身份',
    };
  }
  if (isParentPidInference(request)) {
    return {
      ok: false,
      code: STOP_REFUSED_PARENT_PID_INFERENCE,
      signaled: false,
      reason: '禁止用父 PID 推断来发信号',
    };
  }
  if (typeof request.handleId !== 'string' || request.handleId.length === 0) {
    return {
      ok: false,
      code: STOP_REFUSED_UNKNOWN_IDENTITY,
      signaled: false,
      reason: '缺少本轮持有的 handleId',
    };
  }
  const entry = owned.find((item) => item.id === request.handleId);
  if (!entry) {
    return {
      ok: false,
      code: STOP_REFUSED_UNKNOWN_IDENTITY,
      signaled: false,
      reason: 'handleId 不属于本轮登记的进程',
    };
  }
  if (request.pid != null && entry.pid != null && Number(request.pid) !== Number(entry.pid)) {
    return {
      ok: false,
      code: STOP_REFUSED_UNKNOWN_IDENTITY,
      signaled: false,
      reason: 'pid 与已登记句柄不一致',
    };
  }
  if (entry.exited || entry.released) {
    return {
      ok: true,
      code: STOP_ALREADY_EXITED,
      signaled: false,
      handleId: entry.id,
      pid: entry.pid ?? null,
    };
  }
  const reason = request.reason ?? 'owned';
  const code = reason === 'cancel'
    ? STOP_CANCELLED
    : reason === 'timeout'
      ? STOP_TIMEOUT
      : STOP_OWNED;
  return {
    ok: true,
    code,
    signaled: true,
    handleId: entry.id,
    pid: entry.pid ?? null,
  };
}

export function createOwnedProcessRegistry() {
  const entries = new Map();
  let sequence = 0;

  function snapshot() {
    return [...entries.values()].map((entry) => ({
      id: entry.id,
      pid: entry.pid,
      exited: entry.exited || processExited(entry.process),
      released: entry.released,
    }));
  }

  function register(handle = {}) {
    sequence += 1;
    const id = typeof handle.id === 'string' && handle.id ? handle.id : `owned-${sequence}`;
    const processHandle = handle.process ?? null;
    const entry = {
      id,
      pid: handle.pid ?? processHandle?.pid ?? null,
      process: processHandle,
      close: typeof handle.close === 'function' ? handle.close : null,
      exited: false,
      released: false,
      lastResult: null,
    };
    if (processHandle?.once) {
      processHandle.once('exit', () => {
        entry.exited = true;
      });
    }
    entries.set(id, entry);
    return id;
  }

  function release(handleId) {
    const entry = entries.get(handleId);
    if (entry) entry.released = true;
  }

  async function applyStop(entry, waitMs = STOP_WAIT_MS) {
    if (entry.close) {
      await entry.close();
    } else if (entry.process && !processExited(entry.process) && typeof entry.process.kill === 'function') {
      entry.process.kill('SIGTERM');
    }
    if (!entry.process) {
      entry.exited = true;
      return true;
    }
    const exited = await waitForProcessExit(entry.process, waitMs);
    entry.exited = exited;
    return exited;
  }

  async function stop(request = {}) {
    const decision = inspectStopRequest(request, snapshot());
    if (!decision.ok || !decision.signaled) {
      return decision;
    }
    const entry = entries.get(request.handleId);
    if (!entry || entry.exited || entry.released || processExited(entry.process)) {
      if (entry) entry.exited = processExited(entry.process) || entry.exited === true;
      return {
        ok: true,
        code: STOP_ALREADY_EXITED,
        signaled: false,
        exited: entry?.exited === true,
        handleId: request.handleId,
        pid: entry?.pid ?? null,
      };
    }
    const exited = await applyStop(entry, request.waitMs);
    entry.lastResult = decision;
    return {
      ok: true,
      code: decision.code,
      signaled: true,
      exited,
      handleId: entry.id,
      pid: entry.pid,
    };
  }

  function cancel(handleId) {
    return stop({ handleId, reason: 'cancel' });
  }

  function timeout(handleId) {
    return stop({ handleId, reason: 'timeout' });
  }

  async function closeAll(reason = 'owned') {
    const results = [];
    for (const entry of entries.values()) {
      if (entry.released) continue;
      results.push(await stop({ handleId: entry.id, reason }));
    }
    return results;
  }

  return {
    register,
    release,
    inspect(request) {
      return inspectStopRequest(request, snapshot());
    },
    stop,
    cancel,
    timeout,
    closeAll,
    snapshot,
  };
}

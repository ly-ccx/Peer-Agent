/**
 * 每个项目一个宿主租约。文件 project-runtime/<workspaceId>/host.lease。
 * 获取用独占临时文件再原子挂上；心跳未过期则失败，本进程对该项目只做客户端。
 * 一个进程内一个定时器服务全部租约。正常退出时释放；过期后另一方可以接手。
 */
import {
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { pathOf } from '../data-store.mjs';

export const HOST_LEASE_HEARTBEAT_MS = 5_000;
export const HOST_LEASE_STALE_MS = 20_000;

const WORKSPACE_DIR = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const SURFACES = new Set(['desktop', 'tui']);

/**
 * 带 delegationOrigin 的计划只有在持有该项目租约时才能推进。
 * 普通计划返回 null，调用方保持自己的原逻辑。
 */
export function delegatedPlanRunsWithLease(plan, holds) {
  const origin = plan?.delegationOrigin;
  if (!origin || typeof origin !== 'object' || Array.isArray(origin)) return null;
  const workspaceId = typeof origin.workspaceId === 'string' ? origin.workspaceId.trim() : '';
  if (!workspaceId) return false;
  return typeof holds === 'function' && holds(workspaceId) === true;
}

/** 有 projects/<workspaceId>/profile.json 的项目视为已有机器人。 */
export function listBotWorkspaceIds(projectsDir = null) {
  const dir = projectsDir || pathOf('projects');
  if (!existsSync(dir)) return [];
  const ids = [];
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !WORKSPACE_DIR.test(entry.name)) continue;
    const profile = path.join(dir, entry.name, 'profile.json');
    try {
      if (statSync(profile).isFile() && JSON.parse(readFileSync(profile, 'utf8'))?.status !== 'archived') ids.push(entry.name);
    } catch {
      // 没有档案就不是机器人。
    }
  }
  return ids;
}

export function createHostLease({
  rootDir = null,
  hostId,
  surface,
  pid = process.pid,
  appVersion = '',
  now = () => Date.now(),
  heartbeatMs = HOST_LEASE_HEARTBEAT_MS,
  staleMs = HOST_LEASE_STALE_MS,
  schedule = setInterval,
  cancel = clearInterval,
  projectAgentEnabled = null,
  botWorkspaceIds = null,
} = {}) {
  const id = typeof hostId === 'string' ? hostId.trim() : '';
  if (!id) throw new TypeError('host lease hostId is required');
  if (!SURFACES.has(surface)) throw new TypeError('host lease surface must be desktop or tui');
  const processId = Number.isInteger(pid) && pid > 0 ? pid : process.pid;
  const version = typeof appVersion === 'string' ? appVersion : '';
  const beatMs = Number.isFinite(heartbeatMs) && heartbeatMs > 0 ? heartbeatMs : HOST_LEASE_HEARTBEAT_MS;
  const expireMs = Number.isFinite(staleMs) && staleMs > 0 ? staleMs : HOST_LEASE_STALE_MS;
  const tracksEligibility = typeof projectAgentEnabled === 'function' && typeof botWorkspaceIds === 'function';
  const held = new Map();
  const yieldedUntil = new Map();
  let timer = null;
  let disposed = false;

  function root() {
    return rootDir || pathOf('projectRuntime');
  }

  function workspaceDir(workspaceId) {
    const text = typeof workspaceId === 'string' ? workspaceId.trim() : '';
    return WORKSPACE_DIR.test(text) ? text : '';
  }

  function leaseFile(workspaceId) {
    return path.join(root(), workspaceId, 'host.lease');
  }

  function yieldFile(workspaceId) {
    return path.join(root(), workspaceId, 'host.yield');
  }

  function clock() {
    const value = now();
    if (value instanceof Date) return value.getTime();
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const parsed = Date.parse(String(value ?? ''));
    return Number.isFinite(parsed) ? parsed : Date.now();
  }

  function stamp() {
    return new Date(clock()).toISOString();
  }

  function readLease(workspaceId) {
    const file = leaseFile(workspaceId);
    if (!existsSync(file)) return null;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      const leaseHostId = typeof parsed.hostId === 'string' ? parsed.hostId.trim() : '';
      if (!leaseHostId || !SURFACES.has(parsed.surface)) return null;
      if (!Number.isInteger(parsed.pid) || parsed.pid <= 0) return null;
      const acquiredAt = Date.parse(parsed.acquiredAt);
      const heartbeatAt = Date.parse(parsed.heartbeatAt);
      if (!Number.isFinite(acquiredAt) || !Number.isFinite(heartbeatAt)) return null;
      return {
        hostId: leaseHostId,
        surface: parsed.surface,
        pid: parsed.pid,
        appVersion: typeof parsed.appVersion === 'string' ? parsed.appVersion : '',
        acquiredAt: new Date(acquiredAt).toISOString(),
        heartbeatAt: new Date(heartbeatAt).toISOString(),
      };
    } catch {
      return null;
    }
  }

  function isOurs(lease) {
    return Boolean(lease) && lease.hostId === id && lease.pid === processId;
  }

  function isExpired(lease, at = clock()) {
    if (!lease) return true;
    return at - Date.parse(lease.heartbeatAt) >= expireMs;
  }

  function remember(workspaceId, lease) {
    held.set(workspaceId, lease);
    ensureTimer();
  }

  function ensureTimer() {
    if (timer || disposed) return;
    if (held.size === 0 && !tracksEligibility) return;
    timer = schedule(() => {
      try {
        pulse();
      } catch {
        // 心跳失败留到下一拍；过期后另一方可以接手。
      }
    }, beatMs);
    if (typeof timer?.unref === 'function') timer.unref();
  }

  function stopTimer() {
    if (!timer) return;
    cancel(timer);
    timer = null;
  }

  function buildRecord() {
    const at = stamp();
    return {
      hostId: id,
      surface,
      pid: processId,
      appVersion: version,
      acquiredAt: at,
      heartbeatAt: at,
    };
  }

  function writeTemp(file, record) {
    const tmp = `${file}.${id}.${processId}.tmp`;
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(tmp, `${JSON.stringify(record)}\n`);
    return tmp;
  }

  function removeFile(file) {
    try {
      unlinkSync(file);
    } catch {
      // 已经不在。
    }
  }

  function acquire(workspaceId) {
    const dirName = workspaceDir(workspaceId);
    if (!dirName) return { acquired: false, reason: 'invalid', lease: null };
    if (disposed) return { acquired: false, reason: 'disposed', lease: readLease(dirName) };
    const file = leaseFile(dirName);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const record = buildRecord();
      const tmp = writeTemp(file, record);
      try {
        try {
          linkSync(tmp, file);
          remember(dirName, record);
          return { acquired: true, lease: record };
        } catch (error) {
          if (error?.code !== 'EEXIST') throw error;
        }
        const current = readLease(dirName);
        if (isOurs(current)) {
          remember(dirName, current);
          return { acquired: true, lease: current, alreadyHeld: true };
        }
        if (current && !isExpired(current)) {
          return { acquired: false, reason: 'held', lease: current };
        }
        const aside = `${file}.expired.${processId}.${attempt}`;
        try {
          renameSync(file, aside);
        } catch {
          continue;
        }
        const moved = readLeaseFromPath(aside);
        if (moved && !isExpired(moved) && !isOurs(moved)) {
          try {
            linkSync(aside, file);
          } catch {
            // 另一进程已经挂上新租约。
          }
          removeFile(aside);
          return { acquired: false, reason: 'held', lease: moved };
        }
        try {
          linkSync(tmp, file);
          removeFile(aside);
          remember(dirName, record);
          return { acquired: true, lease: record, tookOver: true };
        } catch {
          continue;
        }
      } finally {
        removeFile(tmp);
      }
    }
    return { acquired: false, reason: 'contended', lease: readLease(dirName) };
  }

  function readLeaseFromPath(file) {
    if (!existsSync(file)) return null;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      if (!parsed || typeof parsed.hostId !== 'string') return null;
      const heartbeatAt = Date.parse(parsed.heartbeatAt);
      if (!Number.isFinite(heartbeatAt)) return null;
      return {
        hostId: parsed.hostId.trim(),
        surface: parsed.surface,
        pid: parsed.pid,
        appVersion: typeof parsed.appVersion === 'string' ? parsed.appVersion : '',
        acquiredAt: parsed.acquiredAt,
        heartbeatAt: new Date(heartbeatAt).toISOString(),
      };
    } catch {
      return null;
    }
  }

  function holds(workspaceId) {
    const dirName = workspaceDir(workspaceId);
    if (!dirName || !held.has(dirName)) return false;
    const current = readLease(dirName);
    if (!isOurs(current)) {
      held.delete(dirName);
      return false;
    }
    return true;
  }

  function release(workspaceId) {
    const dirName = workspaceDir(workspaceId);
    if (!dirName) return false;
    const current = readLease(dirName);
    held.delete(dirName);
    if (current && !isOurs(current)) return false;
    removeFile(leaseFile(dirName));
    if (held.size === 0 && !tracksEligibility) stopTimer();
    return true;
  }

  function releaseAll() {
    for (const workspaceId of [...held.keys()]) release(workspaceId);
  }

  function requestTakeover(workspaceId) {
    const dirName = workspaceDir(workspaceId);
    if (!dirName) return { requested: false, reason: 'invalid' };
    const current = readLease(dirName);
    if (!current || isExpired(current)) return { requested: false, reason: 'free' };
    if (isOurs(current)) return { requested: false, reason: 'self' };
    mkdirSync(path.dirname(yieldFile(dirName)), { recursive: true });
    writeFileSync(yieldFile(dirName), `${JSON.stringify({
      workspaceId: dirName,
      requestedAt: stamp(),
    })}\n`);
    return { requested: true, holder: current.hostId };
  }

  function takeYield(workspaceId) {
    const file = yieldFile(workspaceId);
    if (!existsSync(file) || !holds(workspaceId)) return false;
    release(workspaceId);
    yieldedUntil.set(workspaceId, clock() + expireMs);
    removeFile(file);
    return true;
  }

  function eligibleIds() {
    if (!tracksEligibility) return undefined;
    try {
      if (projectAgentEnabled() !== true) return [];
      const ids = botWorkspaceIds();
      if (!Array.isArray(ids)) return [];
      return [...new Set(ids
        .filter((item) => typeof item === 'string')
        .map((item) => item.trim())
        .filter((item) => WORKSPACE_DIR.test(item)))];
    } catch {
      return null;
    }
  }

  function reconcile() {
    const wanted = eligibleIds();
    if (wanted == null) return;
    const at = clock();
    const wantedSet = new Set(wanted);
    for (const workspaceId of [...held.keys()]) {
      if (!wantedSet.has(workspaceId)) release(workspaceId);
    }
    for (const workspaceId of wantedSet) {
      if ((yieldedUntil.get(workspaceId) ?? 0) > at) continue;
      yieldedUntil.delete(workspaceId);
      if (!holds(workspaceId)) acquire(workspaceId);
    }
  }

  function writeHeartbeat(workspaceId) {
    const file = leaseFile(workspaceId);
    const current = readLease(workspaceId);
    if (!isOurs(current)) {
      held.delete(workspaceId);
      return false;
    }
    const next = { ...current, heartbeatAt: stamp() };
    const tmp = writeTemp(file, next);
    try {
      const again = readLease(workspaceId);
      if (!isOurs(again) || again.heartbeatAt !== current.heartbeatAt) return false;
      renameSync(tmp, file);
      held.set(workspaceId, next);
      return true;
    } catch {
      return false;
    } finally {
      removeFile(tmp);
    }
  }

  function pulse() {
    if (disposed) return;
    for (const workspaceId of [...held.keys()]) takeYield(workspaceId);
    if (tracksEligibility) reconcile();
    for (const workspaceId of [...held.keys()]) writeHeartbeat(workspaceId);
    if (held.size === 0 && !tracksEligibility) stopTimer();
  }

  function dispose() {
    disposed = true;
    stopTimer();
  }

  function close() {
    dispose();
    releaseAll();
  }

  if (tracksEligibility) {
    reconcile();
    ensureTimer();
  }

  return {
    acquire,
    holds,
    release,
    releaseAll,
    requestTakeover,
    pulse,
    dispose,
    close,
    heldWorkspaceIds: () => [...held.keys()],
  };
}

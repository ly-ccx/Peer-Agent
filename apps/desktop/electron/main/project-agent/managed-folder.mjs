/**
 * 受管文件夹在 ~/Peer/<名字>/（可用 projectAgent.managedRoot 改位置）。
 * 这是用户可见的普通目录。删除不直接 unlink，确认后交给废纸篓实现。
 */
import { existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const NAME_MAX = 40;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const ATTEMPTS = 98;

function fail(code) {
  return { ok: false, code };
}

/** 去掉路径分隔符和控制字符。`.`、`..` 和系统保留名无效。 */
export function cleanManagedName(value) {
  const stripped = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/]/g, '')
    .replace(/[\u200b-\u200f\u202a-\u202e]/g, '')
    .trim()
    .replace(/[. ]+$/g, '')
    .trim();
  const name = Array.from(stripped).slice(0, NAME_MAX).join('');
  if (!name || name === '.' || name === '..' || RESERVED.test(name)) return fail('INVALID_NAME');
  return { ok: true, name };
}

export function resolveManagedRoot(managedRoot, homedir = os.homedir()) {
  if (typeof managedRoot === 'string' && managedRoot.trim()) return path.resolve(managedRoot.trim());
  return path.join(homedir, 'Peer');
}

function insideRoot(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative));
}

export function allocateManagedName(root, name, exists = existsSync) {
  const base = path.resolve(root);
  if (!exists(path.join(base, name))) return { ok: true, name, path: path.join(base, name) };
  for (let index = 2; index <= ATTEMPTS + 1; index += 1) {
    const suffix = `-${index}`;
    const room = Math.max(1, NAME_MAX - Array.from(suffix).length);
    const stem = Array.from(name).slice(0, room).join('').replace(/[. ]+$/g, '');
    if (!stem || RESERVED.test(stem)) continue;
    const candidate = `${stem}${suffix}`;
    const folder = path.join(base, candidate);
    if (!exists(folder)) return { ok: true, name: candidate, path: folder };
  }
  return fail('NAME_EXHAUSTED');
}

/**
 * @param {{ name: string, managedRoot?: string, homedir?: string, registry: { ensureForPath: Function }, mkdir?: Function, exists?: Function }} input
 */
export function createManagedFolder({
  name,
  managedRoot = null,
  homedir = os.homedir(),
  registry,
  mkdir = mkdirSync,
  exists = existsSync,
} = {}) {
  if (!registry || typeof registry.ensureForPath !== 'function') return fail('REGISTRY_REQUIRED');
  const cleaned = cleanManagedName(name);
  if (!cleaned.ok) return cleaned;
  const root = resolveManagedRoot(managedRoot, homedir);
  mkdir(root, { recursive: true });
  const allocated = allocateManagedName(root, cleaned.name, exists);
  if (!allocated.ok) return allocated;
  mkdir(allocated.path, { recursive: true });
  const workspace = registry.ensureForPath(allocated.path);
  if (!workspace?.workspaceId) return fail('REGISTRY_REJECTED');
  return {
    ok: true,
    path: allocated.path,
    name: allocated.name,
    managedRoot: root,
    workspace,
  };
}

/**
 * 未确认时什么都不做。确认后只调用注入的废纸篓，不删除目录。
 */
export function discardManagedFolder({
  folder,
  managedRoot,
  confirmed = false,
  moveToTrash,
  homedir = os.homedir(),
} = {}) {
  if (confirmed !== true) return fail('CONFIRM_REQUIRED');
  if (typeof moveToTrash !== 'function') return fail('TRASH_UNAVAILABLE');
  const root = resolveManagedRoot(managedRoot, homedir);
  const target = typeof folder === 'string' ? path.resolve(folder) : '';
  if (!target || !insideRoot(root, target) || path.resolve(target) === path.resolve(root)) {
    return fail('OUTSIDE_MANAGED_ROOT');
  }
  moveToTrash(target);
  return { ok: true, trashed: target };
}

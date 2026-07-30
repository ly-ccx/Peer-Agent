/**
 * Agent 启动时的 macOS 必需系统权限探测（与「导入 Chrome 会话」解耦）。
 *
 * 当前必需项：
 * - Full Disk Access（完全磁盘访问）：Agent 读写用户受保护目录、本地工件、浏览器数据等的前置能力。
 *
 * 探测策略：对若干 TCC 保护目录做只读 readdir；任一存在且 EPERM/EACCES → blocked。
 * 不依赖用户是否安装 Chrome。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  openFullDiskAccessSettings,
  resolveFullDiskAccessDragTarget,
} from './session-import/import-permission-preflight.mjs';

/**
 * @typedef {{
 *   id: string,
 *   status: 'ok' | 'missing' | 'blocked' | 'warn' | 'unsupported' | 'info',
 *   title: string,
 *   detail: string,
 *   action?: 'open_full_disk_access' | 'none',
 *   path?: string,
 * }} StartupPermissionCheck
 */

/**
 * @param {string} targetPath
 * @param {{ fsImpl?: { readdirSync?: Function } }} [options]
 */
export function probeProtectedDirectory(targetPath, options = {}) {
  const fsImpl = options.fsImpl || fs;
  try {
    fsImpl.readdirSync(targetPath);
    return { status: 'ok', code: null, path: targetPath };
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : null;
    if (code === 'ENOENT') return { status: 'missing', code, path: targetPath };
    if (code === 'EPERM' || code === 'EACCES') return { status: 'blocked', code, path: targetPath };
    return { status: 'blocked', code: code || 'unknown', path: targetPath };
  }
}

/**
 * 返回用于 FDA 探测的受保护路径列表（存在性因用户环境而异）。
 * @param {{ homeDir?: string }} [options]
 */
export function listFullDiskAccessProbePaths(options = {}) {
  const home = options.homeDir || os.homedir();
  return [
    path.join(home, 'Library', 'Application Support', 'com.apple.TCC'),
    path.join(home, 'Library', 'Safari'),
    path.join(home, 'Library', 'Mail'),
    path.join(home, 'Library', 'Cookies'),
    path.join(home, 'Library', 'Accounts'),
    path.join(home, 'Library', 'Application Support', 'CallHistoryDB'),
  ];
}

/**
 * 构建启动时 OS 权限快照。
 * @param {{
 *   platform?: string,
 *   isZh?: boolean,
 *   homeDir?: string,
 *   fsImpl?: object,
 *   includeDragTarget?: boolean,
 * }} [options]
 */
export function buildStartupOsPermissions(options = {}) {
  const platform = options.platform || process.platform;
  const isZh = options.isZh !== false;
  /** @type {StartupPermissionCheck[]} */
  const checks = [];
  /** @type {StartupPermissionCheck[]} */
  const required = [];

  if (platform !== 'darwin') {
    const item = {
      id: 'platform',
      status: /** @type {const} */ ('unsupported'),
      title: isZh ? '系统平台' : 'Platform',
      detail: isZh
        ? '启动必需权限检测目前仅针对 macOS。'
        : 'Startup required-permission checks currently target macOS only.',
      action: /** @type {const} */ ('none'),
    };
    checks.push(item);
    return {
      ok: true,
      blocked: false,
      platform,
      checks,
      required: [],
      openFullDiskAccessSupported: false,
      guidance: {
        fullDiskAccess: isZh
          ? '非 macOS 无需完全磁盘访问引导。'
          : 'Full Disk Access guidance is not required on this platform.',
      },
    };
  }

  checks.push({
    id: 'platform',
    status: 'ok',
    title: isZh ? '系统平台' : 'Platform',
    detail: isZh ? 'macOS 可用。' : 'macOS is supported.',
    action: 'none',
  });

  const probePaths = listFullDiskAccessProbePaths({ homeDir: options.homeDir });
  let anyExisting = false;
  let anyReadable = false;
  let anyBlocked = false;
  /** @type {string[]} */
  const blockedPaths = [];
  /** @type {string[]} */
  const readablePaths = [];

  for (const p of probePaths) {
    const probe = probeProtectedDirectory(p, options);
    if (probe.status === 'missing') continue;
    anyExisting = true;
    if (probe.status === 'ok') {
      anyReadable = true;
      readablePaths.push(p);
    } else {
      anyBlocked = true;
      blockedPaths.push(p);
    }
  }

  /** @type {StartupPermissionCheck} */
  let fdaCheck;
  if (anyBlocked) {
    fdaCheck = {
      id: 'full-disk-access',
      status: 'blocked',
      title: isZh ? '完全磁盘访问（Agent 必需）' : 'Full Disk Access (required for Agent)',
      detail: isZh
        ? `系统拒绝读取受保护目录（如 ${blockedPaths[0] || '~/Library/...'}）。Peer Agent 需要完全磁盘访问才能可靠读写本机工作区与用户数据。请到「系统设置 → 隐私与安全性 → 完全磁盘访问权限」中允许本应用，然后完全退出并重启。`
        : `The system blocked reading protected directories (e.g. ${blockedPaths[0] || '~/Library/...'}). Peer Agent needs Full Disk Access to reliably work with local workspace and user data. Grant it in System Settings → Privacy & Security → Full Disk Access, then fully quit and relaunch.`,
      action: 'open_full_disk_access',
      path: blockedPaths[0],
    };
  } else if (anyReadable) {
    fdaCheck = {
      id: 'full-disk-access',
      status: 'ok',
      title: isZh ? '完全磁盘访问（Agent 必需）' : 'Full Disk Access (required for Agent)',
      detail: isZh
        ? `已能读取系统受保护目录（例如 ${readablePaths[0]}）。`
        : `Protected directories are readable (e.g. ${readablePaths[0]}).`,
      action: 'none',
      path: readablePaths[0],
    };
  } else if (!anyExisting) {
    // 探测目标目录均不存在：无法用 EPERM 证伪。保守：不挡启动，但给出 info。
    fdaCheck = {
      id: 'full-disk-access',
      status: 'info',
      title: isZh ? '完全磁盘访问（Agent 必需）' : 'Full Disk Access (required for Agent)',
      detail: isZh
        ? '本机未找到常见受保护目录样本，无法自动判定。若后续读写用户数据失败，请手动开启完全磁盘访问。'
        : 'No common protected directories were found to probe. If later file access fails, grant Full Disk Access manually.',
      action: 'open_full_disk_access',
    };
  } else {
    fdaCheck = {
      id: 'full-disk-access',
      status: 'blocked',
      title: isZh ? '完全磁盘访问（Agent 必需）' : 'Full Disk Access (required for Agent)',
      detail: isZh
        ? '无法确认完全磁盘访问状态，请手动开启。'
        : 'Could not confirm Full Disk Access; please grant it manually.',
      action: 'open_full_disk_access',
    };
  }

  checks.push(fdaCheck);
  if (fdaCheck.status === 'blocked' || fdaCheck.status === 'warn') {
    required.push(fdaCheck);
  }

  const blocked = required.some((c) => c.status === 'blocked')
    || checks.some((c) => c.status === 'blocked' && c.action === 'open_full_disk_access');

  const result = {
    ok: true,
    blocked,
    platform,
    checks,
    required: blocked ? checks.filter((c) => c.status === 'blocked' || c.action === 'open_full_disk_access') : [],
    openFullDiskAccessSupported: true,
    guidance: {
      fullDiskAccess: isZh
        ? '系统设置 → 隐私与安全性 → 完全磁盘访问权限 → 允许 Peer Agent → 完全退出并重启。列表不会自动出现 App，需拖入。'
        : 'System Settings → Privacy & Security → Full Disk Access → allow Peer Agent → fully quit and relaunch. Apps never auto-appear; drag the app into the list.',
    },
  };

  if (options.includeDragTarget !== false) {
    try {
      result.dragTarget = resolveFullDiskAccessDragTarget(options);
    } catch {
      result.dragTarget = { ok: false, error: 'drag_target_failed' };
    }
  }

  return result;
}

export { openFullDiskAccessSettings, resolveFullDiskAccessDragTarget };

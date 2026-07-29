/**
 * 站点会话导入前的 macOS 权限/环境自检。
 * 只做只读探测，不解密 Cookie，不弹 Keychain 授权（除非后续真正导入）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MACOS_CHROMIUM_ADAPTERS } from './chrome-profiles.mjs';

/**
 * @typedef {{
 *   id: string,
 *   status: 'ok' | 'missing' | 'blocked' | 'warn' | 'unsupported' | 'info',
 *   title: string,
 *   detail: string,
 *   action?: 'open_full_disk_access' | 'install_browser' | 'none',
 *   path?: string,
 * }} ImportPermissionCheck
 */

/**
 * 探测单个目录是否可读。
 * @param {string} dir
 * @param {{ fsImpl?: typeof fs }} [options]
 */
export function probeDirectoryAccess(dir, options = {}) {
  const fsp = options.fsImpl || fs;
  try {
    if (!fsp.existsSync(dir)) {
      return { status: 'missing', code: null, message: 'path_missing' };
    }
    // 用 readdir 触发与 scandir 同类的 TCC 拦截。
    fsp.readdirSync(dir);
    return { status: 'ok', code: null, message: null };
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : null;
    if (code === 'EPERM' || code === 'EACCES') {
      return { status: 'blocked', code, message: err?.message || String(err) };
    }
    return { status: 'blocked', code, message: err?.message || String(err) };
  }
}

/**
 * 探测文件是否可复制到临时目录（导入真实路径是 copyFile Cookies）。
 * 目录可读 != Cookies 可 copy：macOS 常在这一步才 EPERM。
 * @param {string} filePath
 * @param {{ fsImpl?: typeof fs, tmpDir?: string }} [options]
 */
export function probeFileCopyAccess(filePath, options = {}) {
  const fsp = options.fsImpl || fs;
  try {
    if (!filePath || !fsp.existsSync(filePath)) {
      return { status: 'missing', code: null, message: 'file_missing' };
    }
    // 轻量读 1 字节：有些环境 read 过但 copy 不过；仍以 copy 为准。
    const tmpRoot = options.tmpDir || path.join(os.tmpdir(), `peer-import-probe-${Date.now()}`);
    fsp.mkdirSync(tmpRoot, { recursive: true, mode: 0o700 });
    const dest = path.join(tmpRoot, 'Cookies.probe');
    try {
      fsp.copyFileSync(filePath, dest);
      return { status: 'ok', code: null, message: null };
    } finally {
      try { fsp.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : null;
    if (code === 'EPERM' || code === 'EACCES') {
      return { status: 'blocked', code, message: err?.message || String(err) };
    }
    return { status: 'blocked', code, message: err?.message || String(err) };
  }
}


/**
 * 汇总导入所需检查项。
 * @param {{ platform?: string, adapters?: typeof MACOS_CHROMIUM_ADAPTERS, fsImpl?: typeof fs, isZh?: boolean }} [options]
 */
export function buildSessionImportPreflight(options = {}) {
  const platform = options.platform || process.platform;
  const isZh = options.isZh !== false;
  /** @type {ImportPermissionCheck[]} */
  const checks = [];

  if (platform !== 'darwin') {
    checks.push({
      id: 'platform',
      status: 'unsupported',
      title: isZh ? '系统平台' : 'Platform',
      detail: isZh
        ? '站点会话导入目前仅支持 macOS。'
        : 'Site session import currently supports macOS only.',
      action: 'none',
    });
    return {
      ok: false,
      ready: false,
      blocked: true,
      checks,
      openFullDiskAccessSupported: false,
    };
  }

  checks.push({
    id: 'platform',
    status: 'ok',
    title: isZh ? '系统平台' : 'Platform',
    detail: isZh ? 'macOS 可用。' : 'macOS is supported.',
    action: 'none',
  });

  const adapters = options.adapters || MACOS_CHROMIUM_ADAPTERS;
  let anyBrowserPresent = false;
  let anyBrowserReadable = false;
  let anyBrowserBlocked = false;

  let anyCookieCopyOk = false;
  let anyCookieCopyBlocked = false;

  for (const adapter of adapters) {
    const root = adapter.userDataRoot;
    const probe = probeDirectoryAccess(root, options);
    if (probe.status === 'missing') {
      checks.push({
        id: `browser:${adapter.id}`,
        status: 'missing',
        title: isZh ? `${adapter.browserName} 数据目录` : `${adapter.browserName} data directory`,
        detail: isZh
          ? `未找到：${root}（可能未安装该浏览器）。`
          : `Not found: ${root} (browser may not be installed).`,
        action: 'install_browser',
        path: root,
      });
      continue;
    }
    anyBrowserPresent = true;
    if (probe.status === 'ok') {
      anyBrowserReadable = true;
      checks.push({
        id: `browser:${adapter.id}`,
        status: 'ok',
        title: isZh ? `${adapter.browserName} 数据目录` : `${adapter.browserName} data directory`,
        detail: isZh ? `可读：${root}` : `Readable: ${root}`,
        action: 'none',
        path: root,
      });

      // 进一步探测 Cookies 是否可 copy（真实导入路径）。
      const cookieCandidates = [
        path.join(root, 'Default', 'Network', 'Cookies'),
        path.join(root, 'Default', 'Cookies'),
      ];
      let cookiePath = null;
      for (const candidate of cookieCandidates) {
        try {
          if ((options.fsImpl || fs).existsSync(candidate)) {
            cookiePath = candidate;
            break;
          }
        } catch {
          /* ignore */
        }
      }
      if (cookiePath) {
        const cookieProbe = probeFileCopyAccess(cookiePath, options);
        if (cookieProbe.status === 'ok') {
          anyCookieCopyOk = true;
          checks.push({
            id: `cookies:${adapter.id}`,
            status: 'ok',
            title: isZh ? `${adapter.browserName} Cookies 文件` : `${adapter.browserName} Cookies file`,
            detail: isZh ? `可复制：${cookiePath}` : `Copyable: ${cookiePath}`,
            action: 'none',
            path: cookiePath,
          });
        } else if (cookieProbe.status === 'blocked') {
          anyCookieCopyBlocked = true;
          checks.push({
            id: `cookies:${adapter.id}`,
            status: 'blocked',
            title: isZh ? `${adapter.browserName} Cookies 文件` : `${adapter.browserName} Cookies file`,
            detail: isZh
              ? `目录可读，但无法复制 Cookies（${cookieProbe.code || 'EPERM'}）：${cookiePath}。这通常仍是「完全磁盘访问权限」不足：请在系统设置中允许 Peer Agent（或开发态 Electron），然后完全退出并重启后再试。`
              : `Directory is readable, but Cookies copy failed (${cookieProbe.code || 'EPERM'}): ${cookiePath}. This still usually means Full Disk Access is missing for Peer Agent (or Electron in dev). Grant it, fully quit, relaunch, then retry.`,
            action: 'open_full_disk_access',
            path: cookiePath,
          });
        }
      }
    } else {
      anyBrowserBlocked = true;
      checks.push({
        id: `browser:${adapter.id}`,
        status: 'blocked',
        title: isZh ? `${adapter.browserName} 数据目录` : `${adapter.browserName} data directory`,
        detail: isZh
          ? `无法读取：${root}${probe.code ? `（${probe.code}）` : ''}。通常需要在「系统设置 → 隐私与安全性 → 完全磁盘访问权限」中允许 Peer Agent，然后完全退出并重启应用。`
          : `Cannot read: ${root}${probe.code ? ` (${probe.code})` : ''}. Grant Full Disk Access to Peer Agent under System Settings → Privacy & Security, then fully quit and relaunch.`,
        action: 'open_full_disk_access',
        path: root,
      });
    }
  }

  if (!anyBrowserPresent) {
    checks.push({
      id: 'browser-presence',
      status: 'missing',
      title: isZh ? '已安装的 Chromium 系浏览器' : 'Installed Chromium browser',
      detail: isZh
        ? '未检测到 Chrome / Edge / Brave / Chromium 的本地用户数据目录。'
        : 'No local user-data directory found for Chrome / Edge / Brave / Chromium.',
      action: 'install_browser',
    });
  } else if ((anyBrowserBlocked && !anyBrowserReadable) || (anyCookieCopyBlocked && !anyCookieCopyOk)) {
    checks.push({
      id: 'full-disk-access',
      status: 'blocked',
      title: isZh ? '完全磁盘访问权限' : 'Full Disk Access',
      detail: isZh
        ? '系统拦截了浏览器目录或 Cookies 文件复制（常见 EPERM copyfile）。请开启完全磁盘访问权限后，完全退出并重启 Peer Agent。'
        : 'macOS blocked browser directory access or Cookies copy (often EPERM copyfile). Enable Full Disk Access, fully quit, and relaunch Peer Agent.',
      action: 'open_full_disk_access',
    });
  } else if ((anyBrowserBlocked && anyBrowserReadable) || (anyCookieCopyBlocked && anyCookieCopyOk)) {
    checks.push({
      id: 'full-disk-access',
      status: 'warn',
      title: isZh ? '部分浏览器仍受权限限制' : 'Some browsers still restricted',
      detail: isZh
        ? '至少有一个浏览器可用，但仍有目录/Cookies 被拒绝。导入被拦截的浏览器前，请开启完全磁盘访问权限。'
        : 'At least one browser works, but some directories/Cookies are still denied. Enable Full Disk Access before importing those browsers.',
      action: 'open_full_disk_access',
    });
  } else {
    checks.push({
      id: 'full-disk-access',
      status: 'ok',
      title: isZh ? '浏览器目录与 Cookies 访问' : 'Browser directory & Cookies access',
      detail: isZh
        ? '已能读取浏览器目录，并成功探测 Cookies 复制。'
        : 'Browser directories are readable and Cookies copy probe succeeded.',
      action: 'none',
    });
  }

  checks.push({
    id: 'keychain',
    status: 'info',
    title: isZh ? '钥匙串（解密 Cookie 时）' : 'Keychain (when decrypting cookies)',
    detail: isZh
      ? '真正导入时系统可能弹出钥匙串授权；请选择允许。本步自检不会触发弹窗。'
      : 'Importing may prompt for Keychain access; choose Allow. This preflight does not trigger that prompt.',
    action: 'none',
  });

  const blocked = checks.some((c) => c.status === 'blocked' || c.status === 'unsupported');
  // 若探测到 Cookies 复制结果，则以“至少有一个 Cookies 可 copy”为准；否则退回目录可读。
  const ready = (
    (anyCookieCopyOk || (!anyCookieCopyBlocked && anyBrowserReadable))
    && !checks.some((c) => c.status === 'unsupported')
  );

  return {
    ok: true,
    ready,
    blocked: blocked && !ready,
    checks,
    openFullDiskAccessSupported: true,
    guidance: isZh
      ? {
          fullDiskAccess: '系统设置 → 隐私与安全性 → 完全磁盘访问权限 → 允许 Peer Agent（或 Electron 开发版）→ 完全退出并重启。',
        }
      : {
          fullDiskAccess: 'System Settings → Privacy & Security → Full Disk Access → allow Peer Agent (or Electron in dev) → fully quit and relaunch.',
        },
  };
}

/**
 * 打开 macOS「完全磁盘访问权限」设置页（尽力而为）。
 * @param {{ shellOpenExternal?: (url: string) => Promise<void> }} [options]
 */
export async function openFullDiskAccessSettings(options = {}) {
  const openExternal = options.shellOpenExternal;
  if (typeof openExternal !== 'function') {
    return { ok: false, error: 'shell_open_unavailable' };
  }
  // macOS Ventura+ 常用 x-apple.systempreferences URL；失败时回退到通用隐私页。
  const candidates = [
    'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles',
    'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles',
    'x-apple.systempreferences:com.apple.preference.security?Privacy',
  ];
  /** @type {Error|null} */
  let lastErr = null;
  for (const url of candidates) {
    try {
      await openExternal(url);
      return { ok: true, url };
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
    }
  }
  return { ok: false, error: lastErr?.message || 'open_settings_failed' };
}

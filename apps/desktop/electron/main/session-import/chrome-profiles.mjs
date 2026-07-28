/**
 * 发现 macOS 上 Chromium 系浏览器 Profile（只读元数据）。
 * 不返回 Cookie value；路径仅 main 使用。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = () => os.homedir();

/** @typedef {{ id: string, browserName: string, bundleId: string, userDataRoot: string, keychainBrowserId: string }} BrowserAdapterDef */

/** @type {BrowserAdapterDef[]} */
export const MACOS_CHROMIUM_ADAPTERS = [
  {
    id: 'chrome-macos',
    browserName: 'Google Chrome',
    bundleId: 'com.google.Chrome',
    userDataRoot: path.join(HOME(), 'Library/Application Support/Google/Chrome'),
    keychainBrowserId: 'chrome',
  },
  {
    id: 'chromium-macos',
    browserName: 'Chromium',
    bundleId: 'org.chromium.Chromium',
    userDataRoot: path.join(HOME(), 'Library/Application Support/Chromium'),
    keychainBrowserId: 'chromium',
  },
  {
    id: 'edge-macos',
    browserName: 'Microsoft Edge',
    bundleId: 'com.microsoft.edgemac',
    userDataRoot: path.join(HOME(), 'Library/Application Support/Microsoft Edge'),
    keychainBrowserId: 'edge',
  },
  {
    id: 'brave-macos',
    browserName: 'Brave Browser',
    bundleId: 'com.brave.Browser',
    userDataRoot: path.join(HOME(), 'Library/Application Support/BraveSoftware/Brave-Browser'),
    keychainBrowserId: 'brave',
  },
];

/**
 * 解析 Cookie DB 路径：优先 Network/Cookies，回退 Cookies。
 * @param {string} profileDir
 */
export function resolveCookieDbPath(profileDir) {
  const candidates = [
    path.join(profileDir, 'Network', 'Cookies'),
    path.join(profileDir, 'Cookies'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
    } catch {
      /* try next */
    }
  }
  return null;
}

/**
 * @param {BrowserAdapterDef} adapter
 * @param {{ fsImpl?: typeof fs }} [options]
 */
export function listProfilesForAdapter(adapter, options = {}) {
  const fsp = options.fsImpl || fs;
  const root = adapter.userDataRoot;
  if (!fsp.existsSync(root)) {
    return {
      adapterId: adapter.id,
      browserName: adapter.browserName,
      bundleId: adapter.bundleId,
      available: false,
      profiles: [],
    };
  }

  /** @type {Array<{ profileId: string, displayName: string, directory: string, cookieDbPath: string|null }>} */
  const profiles = [];

  // Local State 里的 info_cache（可读则用，否则扫目录）
  /** @type {Record<string, { name?: string }>} */
  let infoCache = {};
  try {
    const localStatePath = path.join(root, 'Local State');
    if (fsp.existsSync(localStatePath)) {
      const raw = fsp.readFileSync(localStatePath, 'utf8');
      const json = JSON.parse(raw);
      infoCache = json?.profile?.info_cache || {};
    }
  } catch {
    infoCache = {};
  }

  const dirents = fsp.readdirSync(root, { withFileTypes: true });
  for (const ent of dirents) {
    if (!ent.isDirectory()) continue;
    const name = ent.name;
    if (name !== 'Default' && !/^Profile \d+$/i.test(name)) continue;
    const profileDir = path.join(root, name);
    const cookieDbPath = resolveCookieDbPath(profileDir);
    const displayName =
      infoCache[name]?.name ||
      (name === 'Default' ? 'Default' : name);
    profiles.push({
      profileId: `${adapter.id}::${name}`,
      displayName,
      directory: name,
      cookieDbPath,
      profileDir,
    });
  }

  profiles.sort((a, b) => {
    if (a.directory === 'Default') return -1;
    if (b.directory === 'Default') return 1;
    return a.directory.localeCompare(b.directory);
  });

  return {
    adapterId: adapter.id,
    browserName: adapter.browserName,
    bundleId: adapter.bundleId,
    available: true,
    userDataRoot: root,
    keychainBrowserId: adapter.keychainBrowserId,
    profiles,
  };
}

/**
 * 列出本机可用的 Chromium 系浏览器与 Profile 摘要。
 * @param {{ adapters?: BrowserAdapterDef[], fsImpl?: typeof fs }} [options]
 */
export function listChromeBrowserSources(options = {}) {
  const adapters = options.adapters || MACOS_CHROMIUM_ADAPTERS;
  return adapters
    .map((a) => listProfilesForAdapter(a, options))
    .filter((s) => s.available && s.profiles.length > 0);
}

/**
 * 将短期 profileId 解析为内部路径信息。
 * @param {string} profileId
 * @param {{ adapters?: BrowserAdapterDef[], fsImpl?: typeof fs }} [options]
 */
export function resolveProfileById(profileId, options = {}) {
  const sources = listChromeBrowserSources(options);
  for (const src of sources) {
    for (const p of src.profiles) {
      if (p.profileId === profileId) {
        return {
          ok: true,
          adapterId: src.adapterId,
          browserName: src.browserName,
          keychainBrowserId: src.keychainBrowserId,
          userDataRoot: src.userDataRoot,
          profile: p,
        };
      }
    }
  }
  return { ok: false, error: 'profile_not_found' };
}

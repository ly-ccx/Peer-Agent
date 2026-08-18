import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const ICON_KEY = /<key>CFBundleIconFile<\/key>\s*<string>([^<]+)<\/string>/;
const ICON_NAME_KEY = /<key>CFBundleIconName<\/key>\s*<string>([^<]+)<\/string>/;

function normalizeIconFile(value) {
  const name = String(value || '').trim();
  if (!name) return null;
  return name.endsWith('.icns') ? name : `${name}.icns`;
}

/**
 * 从 .app 的 Info.plist 解析图标文件名。
 * 只做字符串抽取，避免依赖 Electron / plutil，方便单测。
 */
export function resolveMacAppIconFile(plistText) {
  if (!plistText || typeof plistText !== 'string') return null;
  const file = plistText.match(ICON_KEY)?.[1];
  if (file) return normalizeIconFile(file);
  const name = plistText.match(ICON_NAME_KEY)?.[1];
  return normalizeIconFile(name);
}

const ICON_FILE_EXT = /\.(icns|png|jpe?g|webp|ico|tiff?)$/i;

/** 已经是图标文件时直接返回，不要再按 .app 去找 Info.plist。 */
export function isMacAppIconFile(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  return ICON_FILE_EXT.test(filePath);
}

export function resolveMacAppIconPath(appPath, { exists = existsSync, readFile = readFileSync } = {}) {
  if (!appPath || typeof appPath !== 'string') return null;
  if (isMacAppIconFile(appPath)) return exists(appPath) ? appPath : null;
  const plistPath = path.join(appPath, 'Contents', 'Info.plist');
  if (!exists(plistPath)) return null;
  let text = '';
  try {
    text = readFile(plistPath, 'utf8');
  } catch {
    return null;
  }
  const iconFile = resolveMacAppIconFile(text);
  if (!iconFile) return null;
  const iconPath = path.join(appPath, 'Contents', 'Resources', iconFile);
  return exists(iconPath) ? iconPath : null;
}

/**
 * 决定怎么读本机图标：
 * - file: 直接 nativeImage.createFromPath
 * - file-icon: 只对 .app / 可执行文件调 getFileIcon
 * - none: 什么都不读，交给 UI 的品牌 SVG
 *
 * 已经是 .icns/.png 时绝不能 getFileIcon，系统会回一张通用文件图把品牌回退盖掉。
 */
export function planMacAppIconRead(appOrExePath, deps = {}) {
  if (!appOrExePath || typeof appOrExePath !== 'string') return { kind: 'none' };
  const iconPath = resolveMacAppIconPath(appOrExePath, deps);
  if (iconPath) return { kind: 'file', path: iconPath };
  if (isMacAppIconFile(appOrExePath)) return { kind: 'none' };
  return { kind: 'file-icon', path: appOrExePath };
}

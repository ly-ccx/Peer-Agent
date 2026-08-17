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

export function resolveMacAppIconPath(appPath, { exists = existsSync, readFile = readFileSync } = {}) {
  if (!appPath || typeof appPath !== 'string') return null;
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

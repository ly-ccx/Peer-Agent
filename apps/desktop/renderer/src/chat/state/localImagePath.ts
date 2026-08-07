/**
 * 本地图片路径识别（纯函数，无 renderer/window 依赖）。
 */

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;

export function isLocalImagePath(filePath: string | null | undefined): boolean {
  if (!filePath || typeof filePath !== 'string') return false;
  const trimmed = filePath.trim();
  if (!trimmed || /\s/.test(trimmed)) return false;
  // ignore URL schemes
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return false;
  return IMAGE_EXT_RE.test(trimmed);
}

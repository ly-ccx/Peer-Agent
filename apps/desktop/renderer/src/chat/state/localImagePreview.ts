/**
 * 聊天气泡内本地图片预览辅助：按需从主进程加载 dataUrl。
 * ADR 59：会话存储不内联整图；预览仅在 UI 层按需读取。
 */

import { clientApi } from '../../clientApi';
export { isLocalImagePath } from './localImagePath';

const pathPreviewCache = new Map<string, string>();
const pathPreviewInflight = new Map<string, Promise<string | null>>();

export function getCachedLocalImageDataUrl(absPath: string): string | null {
  return pathPreviewCache.get(absPath) ?? null;
}

/**
 * 按需读取本地图片为 dataUrl（带内存缓存）。失败返回 null，调用方回退为路径链接。
 */
export async function loadLocalImageDataUrl(
  absPath: string,
  workspaceRoot?: string | null,
  relPath?: string,
): Promise<string | null> {
  const key = absPath;
  const cached = pathPreviewCache.get(key);
  if (cached) return cached;
  const inflight = pathPreviewInflight.get(key);
  if (inflight) return inflight;

  const task = (async () => {
    try {
      const result = await clientApi.readImageDataUrl(
        absPath,
        workspaceRoot ?? undefined,
        relPath,
      );
      if (result?.ok && typeof result.dataUrl === 'string' && result.dataUrl.startsWith('data:image/')) {
        pathPreviewCache.set(key, result.dataUrl);
        return result.dataUrl;
      }
      return null;
    } catch {
      return null;
    } finally {
      pathPreviewInflight.delete(key);
    }
  })();

  pathPreviewInflight.set(key, task);
  return task;
}

/** 测试用：清空缓存 */
export function __resetLocalImagePreviewCacheForTests(): void {
  pathPreviewCache.clear();
  pathPreviewInflight.clear();
}

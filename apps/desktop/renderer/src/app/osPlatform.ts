/**
 * 渲染层平台事实（单一来源）。
 *
 * main 进程未覆写 userAgent（electron/main 无 setUserAgent 调用），
 * 因此 UA 检测与 main.tsx 既有的 vibrancy 标记同源。
 * CSS 通过 :root[data-os] 门控 macOS 交通灯专属的窗口留白：
 * 非 darwin 平台上 hiddenInset 窗口没有系统交通灯，不应保留这些预留。
 */
export type RendererOs = 'darwin' | 'other';

/** 从 UA 判定平台；只区分「有系统交通灯的 darwin」与其余平台。 */
export function detectRendererOs(userAgent: string): RendererOs {
  return /Macintosh|Mac OS X/.test(userAgent) ? 'darwin' : 'other';
}

// 纯展示格式化工具：时间 / 时长 / 字节 / token 计数。
//
// 这些函数从 ChatSurface.tsx 抽出，仅做无副作用的字符串格式化，不触碰 React、
// 不读写本地能力、不参与 System Context 组装。属于「界面表达」层的纯逻辑 Module，
// 放在 chat/state/ 与既有纯逻辑模块（composerPersistence / interactionToolView 等）同侧，
// 以便独立单测、被组件复用。行为与原 ChatSurface 实现保持一致。

/** 把时间戳格式化为简洁时间：当天只显示时:分，跨天追加「月 日」。 */
export function formatTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return time;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}

/** 把毫秒时长格式化为简洁可读形式：1.2s / 45s / 3m12s / 1h03m。 */
export function formatDuration(ms: number): string {
  if (ms < 0) ms = 0;
  if (ms < 1000) return `${ms}ms`;
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 10) return `${(ms / 1000).toFixed(1)}s`;
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return `${min}m${String(sec).padStart(2, '0')}s`;
  const hr = Math.floor(min / 60);
  return `${hr}h${String(min % 60).padStart(2, '0')}m`;
}

/** 把字节数格式化为 B / KB / MB。 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 把 token 数格式化为简洁形式：<1000 原样，否则以 k 为单位保留一位小数。 */
export function formatTokenCount(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  return `${(tokens / 1000).toFixed(1)}k`;
}

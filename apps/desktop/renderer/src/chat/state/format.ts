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

/**
 * 把 token 数格式化为简洁形式：
 * - < 1_000：原样
 * - < 1_000_000：X.Xk
 * - < 1_000_000_000：X.XM
 * - ≥ 1_000_000_000：X.XB
 */
export function formatTokenCount(tokens: number): string {
  const n = Number.isFinite(tokens) ? Math.max(0, tokens) : 0;
  if (n < 1_000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}k`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return `${(n / 1_000_000_000).toFixed(1)}B`;
}

/**
 * 大数量级中文近似：≥ 1 亿时返回 `≈ X.X 亿`，否则返回 null。
 * 供使用统计等大数字卡片在 k/M/B 旁补充可读性。
 */
export function formatTokenYiApprox(tokens: number): string | null {
  const n = Number.isFinite(tokens) ? Math.max(0, tokens) : 0;
  if (n < 100_000_000) return null;
  const yi = n / 100_000_000;
  // 1 亿级保留 1 位；≥ 100 亿保留整数，避免过长
  if (yi >= 100) return `≈ ${Math.round(yi)} 亿`;
  return `≈ ${yi.toFixed(1)} 亿`;
}

// 尾部周期性复读检测（方案 A）。
//
// 背景：模型偶发陷入死循环，持续高速吐出同一片段（如
//   `'updater.modal.downloadingTitle': '正在下载更新…',\n` 反复几十次），
// 造成刷屏、烧 token、且用户点停止后仍有积压 delta 涌出。本模块提供纯函数式
// 的「尾部周期检测」，由主进程在 delta 收口点调用，命中后主动 abort 收口本轮。
//
// 判定策略（尾部周期检测）：
//   取累积文本的尾部窗口，尝试周期 p ∈ [1, maxPeriod]，以尾部长度 p 的片段为
//   重复单元，向前逐段比对，统计连续重复次数；任一周期达到 minRepeats 即判定命中。
//   仅看尾部而非全文，避免正常样板代码（早期出现过的重复结构）误伤，也把开销
//   限制在常数窗口内。
//
// 参数取值（保守，降低误伤）：
//   - minLength：本轮累积不足此长度不检测（正常长回答不受影响）。
//   - maxPeriod：重复单元的最大长度（超长周期不视为“卡死复读”）。
//   - minRepeats：连续重复达到此次数才判定（远高于正常文本的自然重复）。
//   - windowSize：只在尾部这个窗口内检测，控制开销。

export const DEFAULT_REPETITION_OPTIONS = Object.freeze({
  minLength: 2000,
  maxPeriod: 200,
  minRepeats: 12,
  windowSize: 4096,
});

/**
 * 检测字符串尾部是否存在周期性复读。
 *
 * @param {string} text 累积文本。
 * @param {object} [options] 覆盖默认阈值。
 * @returns {{ period: number, repeats: number, unit: string } | null}
 *   命中时返回周期长度、连续重复次数与重复单元；未命中返回 null。
 */
export function detectTailRepetition(text, options = {}) {
  const { minLength, maxPeriod, minRepeats, windowSize } = {
    ...DEFAULT_REPETITION_OPTIONS,
    ...options,
  };

  if (typeof text !== 'string') return null;
  if (text.length < minLength) return null;

  const tail = text.length > windowSize ? text.slice(text.length - windowSize) : text;
  const n = tail.length;

  for (let p = 1; p <= maxPeriod; p += 1) {
    // 单元长度 p 至少要能容纳 minRepeats 次重复才可能命中，否则直接停止外层。
    if (p * minRepeats > n) break;

    let repeats = 1;
    let i = n - p;
    while (i - p >= 0) {
      let match = true;
      for (let k = 0; k < p; k += 1) {
        if (tail[i - p + k] !== tail[i + k]) {
          match = false;
          break;
        }
      }
      if (!match) break;
      repeats += 1;
      i -= p;
    }

    if (repeats >= minRepeats) {
      return { period: p, repeats, unit: tail.slice(n - p) };
    }
  }

  return null;
}

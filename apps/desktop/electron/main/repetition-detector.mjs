// 尾部周期性复读检测（方案 A）。
//
// 背景：模型偶发陷入死循环，持续高速吐出同一片段（如
//   `'updater.modal.downloadingTitle': '正在下载更新…',\n` 反复几十次），
// 造成刷屏、烧 token、且用户点停止后仍有积压 delta 涌出。本模块提供纯函数式
// 的「尾部周期检测」，由主进程在 delta 收口点调用，命中后主动 abort 收口本轮。
//
// 判定策略（尾部周期检测 + 重复单元质量过滤）：
//   取累积文本的尾部窗口，尝试周期 p ∈ [1, maxPeriod]，以尾部长度 p 的片段为
//   重复单元，向前逐段比对，统计连续重复次数；候选周期达到 minRepeats 后，还要
//   通过重复单元质量过滤，避免把 Markdown 表格分隔符、列表缩进、空白/标点等结构
//   噪声误判为模型卡死复读。
//
// 参数取值（保守，降低误伤）：
//   - minLength：本轮累积不足此长度不检测（正常长回答不受影响）。
//   - maxPeriod：重复单元的最大长度（超长周期不视为“卡死复读”）。
//   - minRepeats：连续重复达到此次数才进入候选判断（远高于正常文本的自然重复）。
//   - windowSize：只在尾部这个窗口内检测，控制开销。
//   - minSubstantiveChars：重复单元至少包含多少实质字符（中文/字母/数字）才自动中断。
//   - singleCharMinRepeats：单字符刷屏需达到更高重复次数才自动中断，降低短尾误伤。

export const DEFAULT_REPETITION_OPTIONS = Object.freeze({
  minLength: 2000,
  maxPeriod: 200,
  minRepeats: 12,
  windowSize: 4096,
  minSubstantiveChars: 6,
  singleCharMinRepeats: 100,
});

const SUBSTANTIVE_CHAR_RE = /[\p{L}\p{N}]/u;

function countSubstantiveChars(value) {
  let count = 0;
  for (const char of value) {
    if (SUBSTANTIVE_CHAR_RE.test(char)) count += 1;
  }
  return count;
}

function sanitizePreview(value, maxLength = 120) {
  const escaped = String(value)
    .replaceAll('\\', '\\\\')
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r')
    .replaceAll('\t', '\\t');
  return escaped.length > maxLength ? `${escaped.slice(0, maxLength)}…` : escaped;
}

function isActionableRepetitionUnit(unit, repeats, options) {
  if (!unit) return { actionable: false, reason: 'empty_unit', substantiveChars: 0 };

  const substantiveChars = countSubstantiveChars(unit);
  if (unit.length === 1) {
    return {
      actionable: repeats >= options.singleCharMinRepeats,
      reason: repeats >= options.singleCharMinRepeats ? 'single_char_flood' : 'single_char_below_threshold',
      substantiveChars,
    };
  }

  if (substantiveChars < options.minSubstantiveChars) {
    return {
      actionable: false,
      reason: 'low_substantive_content',
      substantiveChars,
    };
  }

  return { actionable: true, reason: 'periodic_substantive_unit', substantiveChars };
}

/**
 * 检测字符串尾部是否存在周期性复读。
 *
 * @param {string} text 累积文本。
 * @param {object} [options] 覆盖默认阈值。
 * @returns {{ period: number, repeats: number, unit: string, unitPreview: string, reason: string, substantiveChars: number } | null}
 *   命中时返回周期长度、连续重复次数、重复单元与诊断信息；未命中返回 null。
 */
export function detectTailRepetition(text, options = {}) {
  const resolvedOptions = {
    ...DEFAULT_REPETITION_OPTIONS,
    ...options,
  };
  const { minLength, maxPeriod, minRepeats, windowSize } = resolvedOptions;

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
      const unit = tail.slice(n - p);
      const verdict = isActionableRepetitionUnit(unit, repeats, resolvedOptions);
      if (!verdict.actionable) continue;
      return {
        period: p,
        repeats,
        unit,
        unitPreview: sanitizePreview(unit),
        reason: verdict.reason,
        substantiveChars: verdict.substantiveChars,
      };
    }
  }

  return null;
}

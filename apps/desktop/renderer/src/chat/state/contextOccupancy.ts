// 右下角上下文占用口径：统一「一次请求的有效上下文」分子。
// 纯函数、无副作用；供 Composer 展示与回归测试共用。
//
// 口径（与主进程 ADR 42 显示口径对齐）：
// - 表示「当前/最近一次实际发送给模型的有效上下文」占窗口比例。
// - 优先采用主进程权威快照（stream done / microcompaction idle）。
// - 发送瞬间会把草稿并入权威种子，避免「发完草稿清空 → 百分比骤降」。
// - 流式中可用本轮 usage 的 input+cacheRead 抬升（agent 多步下一跳），
//   但绝不用 lifetime 计费累计（input+output 跨轮总和）当上下文。
// - 只有确认压缩或切换模型窗口时，才允许显著回落（由上层显式改写权威快照）。

export interface ContextOccupancyInput {
  /** 主进程/发送路径写入的权威有效上下文（不含当前草稿）。 */
  readonly authoritativeContextTokens?: number | null;
  /** 本地历史消息启发式估算（不含草稿）。 */
  readonly historyContextTokens: number;
  /** 当前输入框草稿 + 待发附件。 */
  readonly draftContextTokens?: number;
  /**
   * 本轮流式 usage 快照的输入侧（input + cacheRead）。
   * 仅表示最近一次 provider 请求的输入大小，不是 lifetime。
   */
  readonly streamingInputTokens?: number | null;
}

function finiteNonNegative(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.max(0, value);
}

/**
 * 解析右下角上下文占用分子（token 数）。
 *
 * 优先级：
 * 1. 权威快照 + 草稿
 * 2. 与本轮 streaming input 取 max（多步 agent 下一跳变大时跟上）
 * 3. 无权威时回退本地历史 + 草稿
 */
export function resolveContextOccupancyTokens(input: ContextOccupancyInput): number {
  const draft = finiteNonNegative(input.draftContextTokens) ?? 0;
  const history = finiteNonNegative(input.historyContextTokens) ?? 0;
  const authoritative = finiteNonNegative(input.authoritativeContextTokens);
  const streamingInput = finiteNonNegative(input.streamingInputTokens);

  const base = authoritative != null ? authoritative + draft : history + draft;
  if (streamingInput != null && streamingInput > base) {
    return streamingInput;
  }
  return base;
}

/**
 * 用户点击发送时，把「发送前可见占用」固化为权威种子。
 * 这样草稿清空后百分比不会只因口径切换而骤降；真实压缩/done 仍可覆盖。
 */
export function seedAuthoritativeContextOnSend(input: {
  readonly previousAuthoritativeTokens?: number | null;
  readonly historyContextTokens: number;
  readonly sentDraftTokens: number;
  readonly previousContextWindow?: number | null;
  readonly fallbackContextWindow?: number | null;
}): { contextTokens: number; contextWindow: number | null } {
  const sent = finiteNonNegative(input.sentDraftTokens) ?? 0;
  const history = finiteNonNegative(input.historyContextTokens) ?? 0;
  const previousAuth = finiteNonNegative(input.previousAuthoritativeTokens);

  // 发送前显示 ≈ previousAuth+draft 或 history+draft；发送后草稿清零，
  // 种子至少保留发送前占用，并覆盖「仅本地历史」路径。
  const fromAuthoritative = previousAuth != null ? previousAuth + sent : 0;
  const fromHistory = history + sent;
  const contextTokens = Math.max(fromAuthoritative, fromHistory);

  const window =
    finiteNonNegative(input.previousContextWindow)
    ?? finiteNonNegative(input.fallbackContextWindow)
    ?? null;

  return { contextTokens, contextWindow: window };
}

/**
 * 上下文圆环分子：只接受有效上下文 token。
 * 禁止用计费累计（lifetime input+output）回退，否则长会话会误显示 100%。
 */
export function resolveContextRingTokens(
  contextTokens: number | null | undefined,
): number | null {
  return finiteNonNegative(contextTokens);
}

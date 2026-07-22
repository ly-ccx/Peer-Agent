// 右下角上下文占用：主圆环与压缩触发拆成双口径。
// 纯函数、无副作用；供 Composer 展示与回归测试共用。
//
// 口径：
// - contextTokens：本回合实际发送给模型的上下文占用（主圆环）。
// - triggerTokens：与 Runtime preflight 同源的压缩触发压力（tooltip 第二行，不驱动主圆环）。
// - 优先采用主进程双字段快照（stream done / compaction event）。
// - 发送瞬间会把草稿并入权威种子，避免「发完草稿清空 → 百分比骤降」。
// - 流式中可用本轮 usage 的 input+cacheRead 抬升（agent 多步下一跳），
//   但绝不用 lifetime 计费累计（input+output 跨轮总和）当上下文。
// - 只有确认 Layer 1 / 语义压缩或切换模型窗口时，才允许显著回落
//   （由上层显式改写权威快照）。

export interface ContextOccupancyInput {
  /** 主进程/发送路径写入的权威实际上下文占用（不含当前草稿）。 */
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
 * 1. 权威占用 + 草稿
 * 2. 与本轮 streaming input 取 max（真实输入超过估算时跟上）
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
 * 发送前尚无双口径分叉时，context 与 trigger 同值。
 */
export function seedAuthoritativeContextOnSend(input: {
  readonly previousAuthoritativeTokens?: number | null;
  readonly previousTriggerTokens?: number | null;
  readonly historyContextTokens: number;
  readonly sentDraftTokens: number;
  readonly previousContextWindow?: number | null;
  readonly fallbackContextWindow?: number | null;
}): AuthoritativeContextSnapshot {
  const sent = finiteNonNegative(input.sentDraftTokens) ?? 0;
  const history = finiteNonNegative(input.historyContextTokens) ?? 0;
  const previousAuth = finiteNonNegative(input.previousAuthoritativeTokens);
  const previousTrigger = finiteNonNegative(input.previousTriggerTokens);

  // 发送前显示 ≈ previousAuth+draft 或 history+draft；发送后草稿清零，
  // 种子至少保留发送前占用，并覆盖「仅本地历史」路径。
  const fromAuthoritative = previousAuth != null ? previousAuth + sent : 0;
  const fromHistory = history + sent;
  const contextTokens = Math.max(fromAuthoritative, fromHistory);
  const fromTrigger = previousTrigger != null ? previousTrigger + sent : 0;
  const triggerTokens = Math.max(fromTrigger, contextTokens);

  const window =
    finiteNonNegative(input.previousContextWindow)
    ?? finiteNonNegative(input.fallbackContextWindow)
    ?? null;

  return { contextTokens, triggerTokens, contextWindow: window };
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

export type AuthoritativeContextSnapshot = {
  /** 实际发送上下文（主圆环）。 */
  readonly contextTokens: number;
  /** 压缩触发压力（tooltip / preflight 同源）。 */
  readonly triggerTokens: number;
  readonly contextWindow: number | null;
};

function mergeMonotonicField(input: {
  readonly previous: number | null | undefined;
  readonly next: number | null | undefined;
  readonly mode: 'midturn' | 'final';
  readonly windowShrunk: boolean;
}): number | null {
  const next = finiteNonNegative(input.next);
  const prev = finiteNonNegative(input.previous);
  if (next == null) return prev;
  if (prev == null || input.mode === 'final') return next;
  if (!input.windowShrunk && next + 1 < prev) return prev;
  return next;
}

/**
 * 合并权威上下文快照（双口径）。
 *
 * - final：stream done / 语义压缩完成。允许绝对写入（含真实回落）。
 * - midturn：同一回合中途（如 microcompaction idle）。未确认压缩时禁止显著回落，
 *   只允许抬升或保留旧值；窗口显著变小（切模型）时才允许回落。
 *
 * 两个字段各自单调合并；缺省字段沿用 previous。
 */
export function mergeAuthoritativeContextSnapshot(input: {
  readonly previous: AuthoritativeContextSnapshot | null | undefined;
  /** 实际发送上下文。缺省时沿用 previous.contextTokens。 */
  readonly nextContextTokens?: number | null;
  /** 压缩触发压力。缺省时沿用 previous.triggerTokens；若 previous 也无则回退到 nextContextTokens。 */
  readonly nextTriggerTokens?: number | null;
  /**
   * @deprecated 兼容旧调用：仅传 nextTokens 时同时写入 context/trigger。
   * 新代码请显式传 nextContextTokens / nextTriggerTokens。
   */
  readonly nextTokens?: number | null;
  readonly nextWindow?: number | null;
  readonly mode: 'midturn' | 'final';
}): AuthoritativeContextSnapshot | null {
  const legacy = finiteNonNegative(input.nextTokens);
  const rawContext =
    finiteNonNegative(input.nextContextTokens)
    ?? legacy;
  const rawTrigger =
    finiteNonNegative(input.nextTriggerTokens)
    ?? legacy;

  const prevContext = finiteNonNegative(input.previous?.contextTokens);
  const prevTrigger =
    finiteNonNegative(input.previous?.triggerTokens)
    ?? prevContext;

  if (rawContext == null && rawTrigger == null) {
    if (!input.previous) return null;
    return {
      contextTokens: prevContext ?? 0,
      triggerTokens: prevTrigger ?? prevContext ?? 0,
      contextWindow: input.previous.contextWindow ?? null,
    };
  }

  const nextWindow =
    finiteNonNegative(input.nextWindow)
    ?? (input.previous?.contextWindow ?? null);

  const prevWindow = finiteNonNegative(input.previous?.contextWindow);
  const windowShrunk =
    prevWindow != null
    && nextWindow != null
    && nextWindow < prevWindow * 0.9;

  const contextTokens = mergeMonotonicField({
    previous: prevContext,
    next: rawContext,
    mode: input.mode,
    windowShrunk,
  });
  const triggerTokens = mergeMonotonicField({
    previous: prevTrigger,
    next: rawTrigger ?? rawContext,
    mode: input.mode,
    windowShrunk,
  });

  if (contextTokens == null && triggerTokens == null) return null;

  const resolvedContext = contextTokens ?? triggerTokens ?? 0;
  const resolvedTrigger = Math.max(triggerTokens ?? resolvedContext, resolvedContext);

  return {
    contextTokens: resolvedContext,
    triggerTokens: resolvedTrigger,
    contextWindow: nextWindow,
  };
}

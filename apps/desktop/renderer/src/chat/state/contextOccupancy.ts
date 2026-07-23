// ADR 52：右下角与 Runtime preflight 共用“下一次最终请求预计输入”这一口径。
// Renderer 只做草稿增量和事件快照合并，不用累计计费 usage 构造上下文占用。
//
// 语义：
// - null = 未知（尚未恢复 / 无效快照）
// - >0  = 有效占用
// - 0   只允许出现在「真的空会话」；绝不能作为权威值去盖掉已有历史

export interface ContextOccupancyInput {
  readonly historyContextTokens: number;
  readonly draftContextTokens: number;
  readonly authoritativeNextRequestInputTokens?: number | null;
  /** Existing conversations stay unknown until messages and the persisted Runtime snapshot restore together. */
  readonly contextReady?: boolean;
}

export interface SeedAuthoritativeContextInput {
  readonly previousNextRequestInputTokens?: number | null;
  readonly historyContextTokens: number;
  readonly draftContextTokens: number;
  readonly contextWindow?: number | null;
}

export interface SeedAuthoritativeContextResult {
  readonly nextRequestInputTokens: number;
  readonly contextWindow: number | null;
}

export interface AuthoritativeContextSnapshot {
  readonly nextRequestInputTokens: number;
  readonly contextWindow: number | null;
}

function finiteNonNegative(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.max(0, value);
}

/** 权威占用只接受 >0；0/NaN/负数一律视为缺失，避免把「空值」锁成 0%。 */
function finitePositive(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return value;
}

export function resolveContextOccupancyTokens(input: ContextOccupancyInput): number | null {
  if (input.contextReady === false) return null;
  const history = finiteNonNegative(input.historyContextTokens) ?? 0;
  const draft = finiteNonNegative(input.draftContextTokens) ?? 0;
  // 权威 0 不能盖掉本地历史：真·空会话时 history 也是 0，结果仍是 0。
  const authoritative = finitePositive(input.authoritativeNextRequestInputTokens);
  return (authoritative ?? history) + draft;
}

export function seedAuthoritativeContextOnSend(
  input: SeedAuthoritativeContextInput,
): SeedAuthoritativeContextResult {
  const history = finiteNonNegative(input.historyContextTokens) ?? 0;
  const draft = finiteNonNegative(input.draftContextTokens) ?? 0;
  // 发送瞬间：显示口径是「权威基线 + 草稿」。草稿随发送清空后，必须把草稿并入权威种子。
  // previous 缺失/0 时回退本地历史，避免空权威把环打成 0%。
  const base = finitePositive(input.previousNextRequestInputTokens) ?? history;
  return {
    nextRequestInputTokens: base + draft,
    contextWindow: finiteNonNegative(input.contextWindow),
  };
}

export function resolveContextRingTokens(value: number | null | undefined): number | null {
  return finiteNonNegative(value);
}

export function mergeAuthoritativeContextSnapshot(input: {
  readonly previous: AuthoritativeContextSnapshot | null;
  readonly nextRequestInputTokens: number | null;
  readonly nextWindow: number | null;
  readonly mode: 'midturn' | 'final';
}): AuthoritativeContextSnapshot | null {
  const previousTokens = finiteNonNegative(input.previous?.nextRequestInputTokens);
  // 0 不当作有效权威覆盖：压缩/完成只会给出正数投影；0 视为缺失快照。
  const nextTokens = finitePositive(input.nextRequestInputTokens);
  const previousWindow = finiteNonNegative(input.previous?.contextWindow);
  const nextWindow = finiteNonNegative(input.nextWindow) ?? previousWindow;
  if (nextTokens == null && previousTokens == null) return null;

  // midturn：只升不降，防乱序回退。
  // final：允许被真实投影替换；缺失/0 则保留 previous，绝不写入伪 0。
  const resolvedTokens = input.mode === 'final'
    ? (nextTokens ?? previousTokens)
    : Math.max(previousTokens ?? 0, nextTokens ?? 0);

  if (resolvedTokens == null) return null;

  return {
    nextRequestInputTokens: resolvedTokens,
    contextWindow: nextWindow,
  };
}

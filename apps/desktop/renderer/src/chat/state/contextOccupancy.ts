// ADR 52：右下角与 Runtime preflight 共用“下一次最终请求预计输入”这一口径。
// Renderer 只做草稿增量和事件快照合并，不用累计计费 usage 构造上下文占用。

export interface ContextOccupancyInput {
  readonly historyContextTokens: number;
  readonly draftContextTokens: number;
  readonly authoritativeNextRequestInputTokens?: number | null;
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

export function resolveContextOccupancyTokens(input: ContextOccupancyInput): number {
  const history = finiteNonNegative(input.historyContextTokens) ?? 0;
  const draft = finiteNonNegative(input.draftContextTokens) ?? 0;
  const authoritative = finiteNonNegative(input.authoritativeNextRequestInputTokens);
  return (authoritative ?? history) + draft;
}

export function seedAuthoritativeContextOnSend(
  input: SeedAuthoritativeContextInput,
): SeedAuthoritativeContextResult {
  const nextRequestInputTokens = resolveContextOccupancyTokens({
    historyContextTokens: input.historyContextTokens,
    draftContextTokens: input.draftContextTokens,
    authoritativeNextRequestInputTokens: input.previousNextRequestInputTokens,
  });
  return {
    nextRequestInputTokens,
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
  const nextTokens = finiteNonNegative(input.nextRequestInputTokens);
  const previousWindow = finiteNonNegative(input.previous?.contextWindow);
  const nextWindow = finiteNonNegative(input.nextWindow) ?? previousWindow;
  if (nextTokens == null && previousTokens == null) return null;

  // 同一回合的过渡事件不允许因乱序而回退；final（stream done 或压缩落盘）可绝对写入。
  const resolvedTokens = input.mode === 'final'
    ? (nextTokens ?? previousTokens ?? 0)
    : Math.max(previousTokens ?? 0, nextTokens ?? 0);

  return {
    nextRequestInputTokens: resolvedTokens,
    contextWindow: nextWindow,
  };
}

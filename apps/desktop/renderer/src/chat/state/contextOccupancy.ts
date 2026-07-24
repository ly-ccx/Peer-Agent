// ADR 52：右下角与 Runtime preflight 共用“下一次最终请求预计输入”这一口径。
// Renderer 只做草稿增量和事件快照合并，不用累计计费 usage 构造上下文占用。
//
// 语义：
// - null = 未知（尚未恢复 / 无效快照）
// - >0  = 有效占用
// - 0   只允许出现在「真的空会话」；绝不能作为权威值去盖掉已有历史

export interface ContextOccupancyInput {
  readonly draftContextTokens: number;
  readonly authoritativeNextRequestInputTokens?: number | null;
  /** 流式预览增量：仅在有权威基线时叠加，稳定快照到达后归零。 */
  readonly streamPreviewTokens?: number | null;
  /** Existing conversations stay unknown until messages and the persisted Runtime snapshot restore together. */
  readonly contextReady?: boolean;
}

export interface SeedAuthoritativeContextInput {
  readonly previousNextRequestInputTokens?: number | null;
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
  readonly revision?: number | null;
  readonly streamId?: string | null;
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
  const draft = finiteNonNegative(input.draftContextTokens) ?? 0;
  const preview = finiteNonNegative(input.streamPreviewTokens ?? null) ?? 0;
  // Renderer 只允许在 Runtime 投影之上追加尚未提交的草稿预览与流式 delta 预览。
  // 已落盘历史不是 provider 请求输入，不能作为权威值回退，否则压缩记录会被重复累计。
  const authoritative = finitePositive(input.authoritativeNextRequestInputTokens);
  return authoritative == null ? null : authoritative + draft + Math.ceil(preview);
}

export function seedAuthoritativeContextOnSend(
  input: SeedAuthoritativeContextInput,
): SeedAuthoritativeContextResult | null {
  const draft = finiteNonNegative(input.draftContextTokens) ?? 0;
  const base = finitePositive(input.previousNextRequestInputTokens);
  if (base == null) return null;
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

/**
 * 21 号文档第十三章：消费主进程 per-turn 投影生命周期的稳定阶段快照。
 * 同一 streamId 内以单调 revision 丢弃乱序旧快照（替代 midturn Math.max 锁高）；
 * 换流（新 turn）时直接接受新序。非正数 tokens 视为无效，保留旧快照。
 */
export function applyContextProjectionEvent(input: {
  readonly previous: AuthoritativeContextSnapshot | null;
  readonly streamId: string | null;
  readonly revision: number | null | undefined;
  readonly nextRequestInputTokens: number | null | undefined;
  readonly contextWindow: number | null | undefined;
}): AuthoritativeContextSnapshot | null {
  const nextTokens = finitePositive(input.nextRequestInputTokens);
  if (nextTokens == null) return input.previous;
  const revision = Number.isFinite(input.revision) ? Number(input.revision) : null;
  const previous = input.previous ?? null;
  const sameStream = Boolean(
    previous?.streamId && input.streamId && previous.streamId === input.streamId,
  );
  const previousRevision = Number.isFinite(previous?.revision) ? Number(previous?.revision) : null;
  // 同流乱序保护：旧 revision 不得覆盖新快照。
  if (sameStream && revision != null && previousRevision != null && revision <= previousRevision) {
    return previous;
  }
  return {
    nextRequestInputTokens: nextTokens,
    contextWindow: finiteNonNegative(input.contextWindow) ?? previous?.contextWindow ?? null,
    revision,
    streamId: input.streamId ?? null,
  };
}

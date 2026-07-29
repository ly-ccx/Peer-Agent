// 跨宿主压缩恢复形状契约(23 号治理文档不变式 3)。
//
// `_compaction` marker 是 Desktop 与 CLI/TUI 共享会话事实面的一部分:
// 任一端压缩后,另一端必须能按同一形状恢复 active provider history 分界与连续性摘要。
// 两端持久化必须经 buildCompactionMarker() 产出,不得手写字面量,防止字段漂移。

/** 压缩摘要的产生方式,与 runtime-core CompactionMethod 保持同枚举。 */
export type CompactionMarkerMethod = 'llm' | 'structured' | 'structural' | 'fallback_drop';

/** 持久化在 handoff 消息 `_compaction` 字段上的共享 marker 形状。 */
export interface ConversationCompactionMarker {
  readonly method: CompactionMarkerMethod;
  /** LLM 摘要失败降级原因(仅降级时存在)。 */
  readonly fallbackReason?: string;
  readonly fallbackDetail?: string;
  /** 本 marker 所代表的被压缩消息总数(含之前 marker 累计代表的数量)。 */
  readonly originalMessageCount: number;
  /** 之前 marker 已代表的消息数(连续性 carry-forward)。 */
  readonly previousMessageCount: number;
  /** 本次新压缩的消息数。 */
  readonly deltaMessageCount: number;
  readonly beforeTokens: number;
  readonly afterTokens: number;
  /** 累计连续性摘要(carry-forward 后),恢复端经 continuity 通道注入 system context。 */
  readonly summary: string;
  /** 近期关键决策锚点(可为空数组)。 */
  readonly decisionAnchors: readonly string[];
  /** Canonical checkpoint schema version. Legacy markers omit this field. */
  readonly checkpointVersion?: number;
  /** Final-request-derived budget used to compile this marker. */
  readonly budgetSnapshot?: Readonly<Record<string, unknown>> | null;
  /**
   * Versioned structured checkpoint compiled by the Context Compiler.
   * Narrative summary is a rendering of this object, not the sole continuity truth.
   */
  readonly canonicalCheckpoint?: Readonly<Record<string, unknown>> | null;
  /** Recoverable cold-history refs extracted from compacted content. */
  readonly coldHistoryRefs?: readonly string[] | null;
}

function nonNegativeInt(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function normalizeMethod(value: unknown): CompactionMarkerMethod {
  return value === 'llm' || value === 'structured' || value === 'structural' || value === 'fallback_drop'
    ? value
    : 'structured';
}

/**
 * 两端唯一的 `_compaction` marker 构造器。
 * 数值一律钳制为非负整数;method 非法时回退 'structured';可选降级字段仅在非空时出现。
 */
export function buildCompactionMarker(input: {
  readonly method?: unknown;
  readonly fallbackReason?: string | null;
  readonly fallbackDetail?: string | null;
  readonly originalMessageCount?: number | null;
  readonly previousMessageCount?: number | null;
  readonly deltaMessageCount?: number | null;
  readonly beforeTokens?: number | null;
  readonly afterTokens?: number | null;
  readonly summary?: string | null;
  readonly decisionAnchors?: readonly string[] | null;
  readonly checkpointVersion?: number | null;
  readonly budgetSnapshot?: Readonly<Record<string, unknown>> | null;
  readonly canonicalCheckpoint?: Readonly<Record<string, unknown>> | null;
  readonly coldHistoryRefs?: readonly string[] | null;
}): ConversationCompactionMarker {
  const fallbackReason = typeof input.fallbackReason === 'string' && input.fallbackReason.trim()
    ? input.fallbackReason
    : undefined;
  const fallbackDetail = typeof input.fallbackDetail === 'string' && input.fallbackDetail.trim()
    ? input.fallbackDetail
    : undefined;
  return {
    method: normalizeMethod(input.method),
    ...(fallbackReason ? { fallbackReason } : {}),
    ...(fallbackDetail ? { fallbackDetail } : {}),
    originalMessageCount: nonNegativeInt(input.originalMessageCount),
    previousMessageCount: nonNegativeInt(input.previousMessageCount),
    deltaMessageCount: nonNegativeInt(input.deltaMessageCount),
    beforeTokens: nonNegativeInt(input.beforeTokens),
    afterTokens: nonNegativeInt(input.afterTokens),
    summary: typeof input.summary === 'string' ? input.summary : '',
    decisionAnchors: Array.isArray(input.decisionAnchors)
      ? input.decisionAnchors.filter((anchor): anchor is string => typeof anchor === 'string' && anchor.length > 0)
      : [],
    ...(Number.isFinite(input.checkpointVersion) && Number(input.checkpointVersion) > 0
      ? { checkpointVersion: Math.floor(Number(input.checkpointVersion)) }
      : {}),
    ...(input.budgetSnapshot && typeof input.budgetSnapshot === 'object'
      ? { budgetSnapshot: { ...input.budgetSnapshot } }
      : {}),
    ...(input.canonicalCheckpoint && typeof input.canonicalCheckpoint === 'object'
      ? { canonicalCheckpoint: { ...input.canonicalCheckpoint } }
      : {}),
    ...(Array.isArray(input.coldHistoryRefs)
      ? {
          coldHistoryRefs: input.coldHistoryRefs.filter(
            (ref): ref is string => typeof ref === 'string' && ref.trim().length > 0,
          ),
        }
      : {}),
  };
}

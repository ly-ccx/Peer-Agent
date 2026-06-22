import { isRecord } from '../utils/records.ts';

/**
 * batch_search 分路(lane)视图模型。
 *
 * 把 batch_search 工具卡的 args(queries) 与 result(聚合 JSON 字符串/对象) 折叠成
 * 一份按 laneId 唯一的子路状态列表，供 UI 还原截图式"分路检索"
 * （检索中 / 已检索 · N 个结果）。
 *
 * 折叠规则（reducer 语义）：
 *  - 以 args.queries 的顺序与 id 为基准，建立每条 lane 的初始 pending 态。
 *  - result.lanes（聚合 Provider 返回的终态）按 laneId 覆盖对应 lane 的最新阶段
 *    与结果计数；同一 laneId 多次出现时后者覆盖前者（取最新）。
 *  - result 尚未到达（运行中）时，所有 lane 保持 pending（running 显示），
 *    实时逐条 running 中间态依赖未来的 lane 进度事件 IPC seam（本期由终态兜底）。
 *
 * 设计文档：docs/design/batch-search-parallel-aggregation.md
 */

export type BatchLanePhase =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'timeout'
  | 'cancelled';

export interface BatchSearchLaneView {
  readonly laneId: string;
  readonly label?: string;
  readonly query: string;
  readonly phase: BatchLanePhase;
  readonly resultCount?: number;
  readonly errorMessage?: string;
}

export interface BatchSearchAggregateView {
  readonly totalUniqueMatches: number;
  readonly truncated: boolean;
  readonly matches: readonly {
    readonly path: string;
    readonly line: number;
    readonly text: string;
    readonly hitCount: number;
    readonly laneIds: readonly string[];
  }[];
}

export interface BatchSearchView {
  readonly lanes: readonly BatchSearchLaneView[];
  readonly aggregate?: BatchSearchAggregateView;
  readonly status: 'running' | 'success' | 'partial' | 'failed' | 'cancelled' | 'blocked';
}

const VALID_PHASES = new Set<BatchLanePhase>([
  'pending',
  'running',
  'completed',
  'failed',
  'timeout',
  'cancelled',
]);

function coercePhase(value: unknown): BatchLanePhase | undefined {
  return typeof value === 'string' && VALID_PHASES.has(value as BatchLanePhase)
    ? (value as BatchLanePhase)
    : undefined;
}

function parseMaybeJson(value: unknown): unknown {
  if (isRecord(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    try {
      return JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function normalizeAggregate(raw: unknown): BatchSearchAggregateView | undefined {
  if (!isRecord(raw)) return undefined;
  const matchesRaw = Array.isArray(raw.matches) ? raw.matches : [];
  const matches = matchesRaw.filter(isRecord).map((m) => ({
    path: typeof m.path === 'string' ? m.path : '',
    line: typeof m.line === 'number' ? m.line : 0,
    text: typeof m.text === 'string' ? m.text : '',
    hitCount: typeof m.hitCount === 'number' ? m.hitCount : 1,
    laneIds: Array.isArray(m.laneIds) ? m.laneIds.filter((x): x is string => typeof x === 'string') : [],
  }));
  return {
    totalUniqueMatches:
      typeof raw.totalUniqueMatches === 'number' ? raw.totalUniqueMatches : matches.length,
    truncated: raw.truncated === true,
    matches,
  };
}

/**
 * 折叠 batch_search 工具卡为分路视图。
 * @param args 工具入参（含 queries）。
 * @param result 工具结果：可为聚合对象，或后端序列化后的 JSON 字符串；undefined 表示仍在运行。
 */
export function buildBatchSearchView(
  args: Record<string, unknown> | undefined,
  result: unknown,
): BatchSearchView {
  // 1) 以 args.queries 建立 lane 基准顺序与初始 pending。
  const baseLanes = new Map<string, BatchSearchLaneView>();
  const order: string[] = [];
  const queries = args && Array.isArray(args.queries) ? args.queries : [];
  queries.forEach((q, i) => {
    if (!isRecord(q)) return;
    const query = typeof q.query === 'string' ? q.query : '';
    let laneId =
      typeof q.id === 'string' && q.id.trim() ? q.id.trim() : `lane-${i + 1}`;
    if (baseLanes.has(laneId)) laneId = `${laneId}-${i + 1}`;
    const label = typeof q.label === 'string' && q.label.trim() ? q.label.trim() : undefined;
    baseLanes.set(laneId, { laneId, label, query, phase: 'pending' });
    order.push(laneId);
  });

  const parsed = parseMaybeJson(result);
  const resultRecord = isRecord(parsed) ? parsed : undefined;

  // blocked / 无结果（运行中）处理。
  const status = ((): BatchSearchView['status'] => {
    const s = resultRecord?.status;
    if (s === 'blocked') return 'blocked';
    if (s === 'success' || s === 'partial' || s === 'failed' || s === 'cancelled') return s;
    return 'running';
  })();

  // 2) result.lanes 按 laneId 覆盖最新阶段（取最新）。
  const resultLanes = resultRecord && Array.isArray(resultRecord.lanes) ? resultRecord.lanes : [];
  for (const rl of resultLanes) {
    if (!isRecord(rl)) continue;
    const laneId = typeof rl.id === 'string' ? rl.id : typeof rl.laneId === 'string' ? rl.laneId : undefined;
    if (!laneId) continue;
    const phase = coercePhase(rl.status) ?? coercePhase(rl.lanePhase) ?? 'completed';
    const resultCount =
      typeof rl.matchCount === 'number'
        ? rl.matchCount
        : typeof rl.laneResultCount === 'number'
          ? rl.laneResultCount
          : undefined;
    const errorMessage =
      typeof rl.errorMessage === 'string' && rl.errorMessage ? rl.errorMessage : undefined;
    const existing = baseLanes.get(laneId);
    const label =
      existing?.label ??
      (typeof rl.label === 'string' && rl.label ? rl.label : undefined);
    const query =
      existing?.query ?? (typeof rl.query === 'string' ? rl.query : '');
    baseLanes.set(laneId, { laneId, label, query, phase, resultCount, errorMessage });
    if (!order.includes(laneId)) order.push(laneId);
  }

  // 运行中（status=running 且尚无结果 lane）：基准 lane 显示为 running。
  if (status === 'running' && resultLanes.length === 0) {
    for (const id of order) {
      const lane = baseLanes.get(id);
      if (lane) baseLanes.set(id, { ...lane, phase: 'running' });
    }
  }

  const lanes = order.map((id) => baseLanes.get(id)).filter((l): l is BatchSearchLaneView => Boolean(l));
  const aggregate = normalizeAggregate(resultRecord?.aggregated);

  return { lanes, aggregate, status };
}

/** 子路阶段对应的本地化短标签。 */
export function lanePhaseLabel(phase: BatchLanePhase, isZh: boolean): string {
  if (isZh) {
    return (
      {
        pending: '待检索',
        running: '检索中',
        completed: '已检索',
        failed: '失败',
        timeout: '超时',
        cancelled: '已取消',
      } as Record<BatchLanePhase, string>
    )[phase];
  }
  return (
    {
      pending: 'queued',
      running: 'searching',
      completed: 'done',
      failed: 'failed',
      timeout: 'timeout',
      cancelled: 'cancelled',
    } as Record<BatchLanePhase, string>
  )[phase];
}

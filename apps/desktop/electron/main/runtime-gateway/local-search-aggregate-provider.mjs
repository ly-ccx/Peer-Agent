import { randomUUID } from 'node:crypto';
import { runFileSearch } from './local-file-provider.mjs';
import { createPermissionGrant, nowIso } from './tool-result-factory.mjs';

/**
 * local.search.aggregate —— 批量并行检索 + 聚合编排（方案丙）。
 *
 * 设计文档：docs/design/batch-search-parallel-aggregation.md
 *
 * 职责：
 *  - 一次接收多条子查询（lane），并发 fan-out 复用 local-file-provider 的
 *    runFileSearch 执行体（不重写检索逻辑）。
 *  - 每条子路发 started / completed 进度事件（经 context.emitLaneProgress seam），
 *    供 Renderer 还原截图式"分路检索"。
 *  - 聚合去重重排，返回一份聚合 Evidence + 一份只读 PermissionGrant。
 *  - 单条失败/超时隔离，不阻塞其余子路与最终聚合；支持 AbortSignal 取消。
 *
 * 并发完全收敛在本 Provider 内，对核心 agent-loop 串行执行零侵入。
 * 一期仅支持文件/代码内容检索（kind=file_content）。
 */

const CAPABILITY_ID = 'local.search.aggregate';
const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 8;
const MAX_QUERIES = 8;
const DEFAULT_AGGREGATE_CAP = 200;
const DEFAULT_LANE_TIMEOUT_MS = 20_000;
const SUPPORTED_KINDS = new Set(['file_content']);

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

function readArgs(call) {
  if (call.arguments && typeof call.arguments === 'object') return call.arguments;
  if (typeof call.arguments === 'string') {
    try {
      return JSON.parse(call.arguments);
    } catch {
      return {};
    }
  }
  return {};
}

/**
 * 规范化模型给出的子查询列表。返回 { lanes, error }。
 * error 非空时视为入参非法（blocked），不发起任何子路。
 */
function normalizeQueries(rawQueries) {
  if (!Array.isArray(rawQueries) || rawQueries.length === 0) {
    return { error: 'queries must be a non-empty array' };
  }
  if (rawQueries.length > MAX_QUERIES) {
    return { error: `too many queries: max ${MAX_QUERIES}, got ${rawQueries.length}` };
  }
  const lanes = [];
  const usedIds = new Set();
  for (let i = 0; i < rawQueries.length; i += 1) {
    const raw = rawQueries[i];
    if (!raw || typeof raw !== 'object') {
      return { error: `queries[${i}] must be an object` };
    }
    const query = typeof raw.query === 'string' ? raw.query : '';
    if (query.length === 0) {
      return { error: `queries[${i}].query must be a non-empty string` };
    }
    const kind = typeof raw.kind === 'string' ? raw.kind : 'file_content';
    if (!SUPPORTED_KINDS.has(kind)) {
      return { error: `queries[${i}].kind "${kind}" is not supported in this phase (only file_content)` };
    }
    let laneId = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : `lane-${i + 1}`;
    if (usedIds.has(laneId)) laneId = `${laneId}-${i + 1}`;
    usedIds.add(laneId);
    lanes.push({
      laneId,
      label: typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : undefined,
      query,
      path: typeof raw.path === 'string' ? raw.path : undefined,
      caseSensitive: raw.case_sensitive === true,
      maxResults: Number.isInteger(raw.max_results) ? raw.max_results : undefined,
      kind,
    });
  }
  return { lanes };
}

function emitLane(context, payload) {
  if (typeof context.emitLaneProgress === 'function') {
    try {
      context.emitLaneProgress(payload);
    } catch {
      // 进度事件下发失败不影响检索本身；最终聚合 Evidence 的 lanes 兜底。
    }
  }
}

/**
 * 执行单条子路。runFileSearch 为同步阻塞计算，这里用 Promise 包裹以便并发调度，
 * 并在 signal 已 abort 时短路。返回 lane 终态描述（永不抛出，失败被收敛）。
 */
async function runLane(lane, { cwd, signal, context }) {
  if (signal?.aborted) {
    return { ...laneShape(lane, 'cancelled'), matches: [] };
  }

  emitLane(context, {
    laneId: lane.laneId,
    laneLabel: lane.label,
    laneQuery: lane.query,
    lanePhase: 'running',
  });

  const startedAt = Date.now();
  try {
    const fileResult = await withTimeout(
      () =>
        runFileSearch({
          args: {
            query: lane.query,
            path: lane.path,
            case_sensitive: lane.caseSensitive,
            max_results: lane.maxResults,
          },
          cwd,
          requestPermission: context.requestPermission,
        }),
      DEFAULT_LANE_TIMEOUT_MS,
      signal,
    );

    if (fileResult === TIMEOUT) {
      const shape = laneShape(lane, 'timeout');
      emitLane(context, { ...laneEvent(shape) });
      return { ...shape, matches: [] };
    }
    if (fileResult === ABORTED) {
      const shape = laneShape(lane, 'cancelled');
      emitLane(context, { ...laneEvent(shape) });
      return { ...shape, matches: [] };
    }

    let parsed = {};
    try {
      parsed = JSON.parse(fileResult.output || '{}');
    } catch {
      parsed = {};
    }

    if (!fileResult.success || parsed.status === 'blocked' || parsed.status === 'failed') {
      const shape = {
        ...laneShape(lane, 'failed'),
        errorMessage: parsed.reason || fileResult.error || 'search failed',
      };
      emitLane(context, { ...laneEvent(shape) });
      return { ...shape, matches: [] };
    }

    const matches = Array.isArray(parsed.matches) ? parsed.matches : [];
    const shape = {
      ...laneShape(lane, 'completed'),
      matchCount: matches.length,
      fileCount: typeof parsed.fileCount === 'number' ? parsed.fileCount : undefined,
      truncated: parsed.truncated === true,
      durationMs: Date.now() - startedAt,
    };
    emitLane(context, { ...laneEvent(shape) });
    return { ...shape, matches };
  } catch (error) {
    const shape = {
      ...laneShape(lane, 'failed'),
      errorMessage: error?.message || String(error),
    };
    emitLane(context, { ...laneEvent(shape) });
    return { ...shape, matches: [] };
  }
}

function laneShape(lane, phase) {
  return {
    id: lane.laneId,
    label: lane.label,
    query: lane.query,
    status: phase,
    matchCount: 0,
    fileCount: undefined,
    truncated: false,
    errorMessage: null,
  };
}

function laneEvent(shape) {
  return {
    laneId: shape.id,
    laneLabel: shape.label,
    laneQuery: shape.query,
    lanePhase: shape.status,
    laneResultCount: shape.matchCount,
  };
}

const TIMEOUT = Symbol('lane-timeout');
const ABORTED = Symbol('lane-aborted');

/**
 * 为单条同步检索附加超时与取消语义。runFileSearch 同步执行，无法真正中断
 * CPU 计算，这里在调用前后检查 signal/超时，提供 best-effort 隔离。
 */
async function withTimeout(fn, timeoutMs, signal) {
  if (signal?.aborted) return ABORTED;
  return await new Promise((resolvePromise) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolvePromise(TIMEOUT);
    }, timeoutMs);

    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(ABORTED);
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    // 让出事件循环一拍，使 timeout/abort 有机会先于同步计算生效。
    setImmediate(() => {
      if (settled) {
        if (signal) signal.removeEventListener('abort', onAbort);
        return;
      }
      let result;
      try {
        result = fn();
      } catch (error) {
        settled = true;
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        throw error;
      }
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolvePromise(result);
    });
  });
}

/** 受控并发池：按 concurrency 限制同时在跑的 lane 数。 */
async function runWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function pump() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  }
  const runners = [];
  const poolSize = Math.min(concurrency, items.length);
  for (let i = 0; i < poolSize; i += 1) runners.push(pump());
  await Promise.all(runners);
  return results;
}

/** 聚合去重 + 重排。返回 { matches, totalUniqueMatches }。 */
function aggregateMatches(laneResults, { dedupe, cap }) {
  if (!dedupe) {
    const flat = [];
    for (const lane of laneResults) {
      for (const m of lane.matches) {
        flat.push({
          path: m.path,
          line: m.line,
          text: m.text,
          laneIds: [lane.id],
          hitCount: 1,
        });
      }
    }
    const limited = flat.slice(0, cap);
    return { matches: limited, totalUniqueMatches: flat.length, truncated: flat.length > cap };
  }

  const byKey = new Map();
  for (const lane of laneResults) {
    for (const m of lane.matches) {
      const key = `${m.path}:${m.line}`;
      const existing = byKey.get(key);
      if (existing) {
        existing.hitCount += 1;
        if (!existing.laneIds.includes(lane.id)) existing.laneIds.push(lane.id);
      } else {
        byKey.set(key, {
          path: m.path,
          line: m.line,
          text: m.text,
          laneIds: [lane.id],
          hitCount: 1,
        });
      }
    }
  }

  const merged = [...byKey.values()];
  merged.sort((a, b) => {
    if (b.hitCount !== a.hitCount) return b.hitCount - a.hitCount;
    if (b.laneIds.length !== a.laneIds.length) return b.laneIds.length - a.laneIds.length;
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return a.line - b.line;
  });

  const limited = merged.slice(0, cap);
  return { matches: limited, totalUniqueMatches: merged.length, truncated: merged.length > cap };
}

function overallStatus(laneResults, aborted) {
  const completed = laneResults.filter((l) => l.status === 'completed').length;
  const failedLike = laneResults.length - completed;
  if (aborted && completed === 0) return 'cancelled';
  if (failedLike === 0) return 'success';
  if (completed === 0) return 'failed';
  return 'partial';
}

function buildAggregateResult({ call, locale, laneResults, aggregated, status, dedupe }) {
  const lanesSummary = laneResults.map((l) => ({
    id: l.id,
    label: l.label,
    query: l.query,
    status: l.status,
    matchCount: l.matchCount,
    fileCount: l.fileCount,
    truncated: l.truncated,
    errorMessage: l.errorMessage,
  }));

  const headline = `Found ${aggregated.totalUniqueMatches} unique match(es) across ${laneResults.length} lane(s)${aggregated.truncated ? ' (truncated)' : ''}.`;
  const laneLines = lanesSummary.map(
    (l) => `[${l.status}] ${l.label || l.id} · "${l.query}" → ${l.matchCount} match(es)${l.errorMessage ? ` (${l.errorMessage})` : ''}`,
  );
  const matchLines = aggregated.matches.map(
    (m) => `${m.path}:${m.line} (${m.hitCount}x): ${m.text}`,
  );

  const outputPayload = {
    status,
    tool: 'batch_search',
    laneCount: laneResults.length,
    dedupe,
    lanes: lanesSummary,
    aggregated: {
      totalUniqueMatches: aggregated.totalUniqueMatches,
      truncated: aggregated.truncated,
      matches: aggregated.matches,
    },
    preview: [headline, ...laneLines, '', ...matchLines].join('\n'),
  };

  const toolCardLanes = laneResults.map((l) => ({
    laneId: l.id,
    laneLabel: l.label,
    laneQuery: l.query,
    lanePhase: l.status,
    laneResultCount: l.matchCount,
  }));

  return {
    toolCallId: call.toolCallId,
    status: status === 'failed' ? 'failed' : status === 'cancelled' ? 'cancelled' : 'completed',
    outputPreview: outputPayload,
    lanes: toolCardLanes,
    evidence: {
      evidenceId: randomUUID(),
      toolCallId: call.toolCallId,
      summary:
        locale === 'zh-CN'
          ? `批量并行检索完成（${laneResults.length} 路），聚合去重后 ${aggregated.totalUniqueMatches} 条命中，状态：${status}。`
          : `Batch parallel search over ${laneResults.length} lane(s) completed with ${aggregated.totalUniqueMatches} unique match(es), status ${status}.`,
      locale,
      returnedToCloud: false,
      dataLevel: 'D1_internal',
      redactions: [],
      artifactRefs: [],
    },
    completedAt: nowIso(),
  };
}

function buildBlockedResult({ call, locale, reason }) {
  return {
    toolCallId: call.toolCallId,
    status: 'failed',
    outputPreview: {
      status: 'blocked',
      tool: 'batch_search',
      reason,
    },
    evidence: {
      evidenceId: randomUUID(),
      toolCallId: call.toolCallId,
      summary:
        locale === 'zh-CN'
          ? `批量检索入参非法：${reason}。`
          : `batch_search rejected invalid arguments: ${reason}.`,
      locale,
      returnedToCloud: false,
      dataLevel: 'D1_internal',
      redactions: [],
      artifactRefs: [],
    },
    completedAt: nowIso(),
  };
}

export function createLocalSearchAggregateProvider({ workspaceRoot } = {}) {
  async function executeCapability(request, context = {}) {
    const call = request.call;
    if (call.capabilityId !== CAPABILITY_ID) return null;

    const locale = context.locale ?? 'zh-CN';
    const args = readArgs(call);
    const { lanes, error } = normalizeQueries(args.queries);

    if (error) {
      const grant = createPermissionGrant({
        toolCallId: call.toolCallId,
        granted: false,
        scope: call.capabilityId,
        duration: 'denied',
      });
      return { call, grant, result: buildBlockedResult({ call, locale, reason: error }) };
    }

    const cwd = context.workspaceRoot || workspaceRoot || process.cwd();
    const concurrency = clamp(
      args.max_concurrency ?? DEFAULT_CONCURRENCY,
      1,
      MAX_CONCURRENCY,
    );
    const dedupe = args.dedupe !== false;
    const cap = clamp(args.max_aggregate_results ?? DEFAULT_AGGREGATE_CAP, 1, 1_000);
    const signal = context.signal;

    const laneResults = await runWithConcurrency(lanes, concurrency, (lane) =>
      runLane(lane, { cwd, signal, context }),
    );

    const aggregated = aggregateMatches(laneResults, { dedupe, cap });
    const status = overallStatus(laneResults, Boolean(signal?.aborted));

    const grant = createPermissionGrant({
      toolCallId: call.toolCallId,
      granted: true,
      scope: call.capabilityId,
      duration: 'once',
    });

    return {
      call,
      grant,
      result: buildAggregateResult({ call, locale, laneResults, aggregated, status, dedupe }),
    };
  }

  return {
    providerId: 'local.search.aggregate',
    capabilityIds: [CAPABILITY_ID],
    executeCapability,
  };
}

// 供单测使用的内部纯函数导出（不影响 Provider Interface）。
export const __testables = {
  normalizeQueries,
  aggregateMatches,
  overallStatus,
  runWithConcurrency,
  clamp,
};

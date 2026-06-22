import { useState } from 'react';
import {
  buildBatchSearchView,
  lanePhaseLabel,
  type BatchLanePhase,
} from '../../state/batchSearchLaneView';

/**
 * batch_search 工具卡：还原截图式"批量并行检索"——逐条子路状态
 * （检索中 / 已检索 · N 个结果）+ 聚合结果面板。
 *
 * 设计文档：docs/design/batch-search-parallel-aggregation.md
 */

function phaseClass(phase: BatchLanePhase): string {
  switch (phase) {
    case 'completed':
      return 'done';
    case 'failed':
    case 'timeout':
    case 'cancelled':
      return 'error';
    case 'running':
      return 'running';
    default:
      return 'pending';
  }
}

export function BatchSearchToolCard({
  args,
  result,
  isZh,
}: {
  readonly args: Record<string, unknown>;
  readonly result?: string;
  readonly isZh: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const view = buildBatchSearchView(args, result);
  const isRunning = view.status === 'running';

  const title = isZh
    ? `批量检索 · ${view.lanes.length} 路`
    : `Batch search · ${view.lanes.length} lane(s)`;

  const totalLabel =
    view.aggregate != null
      ? isZh
        ? `共 ${view.aggregate.totalUniqueMatches} 条聚合结果${view.aggregate.truncated ? '（已截断）' : ''}`
        : `${view.aggregate.totalUniqueMatches} aggregated match(es)${view.aggregate.truncated ? ' (truncated)' : ''}`
      : isZh
        ? '检索中…'
        : 'searching…';

  return (
    <div
      className={`tool-call-card batch-search-card ${isRunning ? 'running' : 'done'}`}
      onClick={() => setExpanded(!expanded)}
    >
      <div className="tool-call-header">
        <span className="tool-call-label">{title}</span>
        <span className="batch-search-total">{totalLabel}</span>
        <svg
          className="tool-call-expand"
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={expanded ? undefined : { transform: 'rotate(-90deg)' }}
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </div>

      <ul className="batch-search-lanes">
        {view.lanes.map((lane) => (
          <li key={lane.laneId} className={`batch-search-lane ${phaseClass(lane.phase)}`}>
            <span className="batch-search-lane-label">{lane.label || lane.query}</span>
            <span className="batch-search-lane-status">
              {lanePhaseLabel(lane.phase, isZh)}
              {lane.phase === 'completed' && typeof lane.resultCount === 'number'
                ? ` · ${lane.resultCount}${isZh ? ' 个结果' : ''}`
                : ''}
              {lane.errorMessage ? ` (${lane.errorMessage})` : ''}
            </span>
          </li>
        ))}
      </ul>

      {expanded && view.aggregate && view.aggregate.matches.length > 0 ? (
        <div className="batch-search-results">
          {view.aggregate.matches.map((m) => (
            <div className="batch-search-result-row" key={`${m.path}:${m.line}`}>
              <span className="batch-search-result-loc">
                {m.path}:{m.line}
                {m.hitCount > 1 ? ` ·${m.hitCount}×` : ''}
              </span>
              <span className="batch-search-result-text">{m.text}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

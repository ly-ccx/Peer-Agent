import { useState } from 'react';
import {
  buildBatchSearchView,
  lanePhaseLabel,
  type BatchLanePhase,
} from '../../state/batchSearchLaneView';

/**
 * batch_search 工具卡：还原截图式"批量并行检索"——逐条子路状态
 * （色点 + 标签 + 结果计数）+ 聚合结果面板。
 *
 * 设计：方向 B「优雅分路卡」。状态用色点表达，文案随 app i18n（isZh），
 * 结果区路径与代码文本分两行呼吸，带左缘色条分组。
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
  const laneCount = view.lanes.length;

  // 空壳兜底：lanes 尚未解析出来且运行中，显示"准备中"而不是"0 路"。
  const title =
    laneCount === 0 && isRunning
      ? isZh
        ? '批量检索 · 准备中…'
        : 'Batch search · preparing…'
      : isZh
        ? `批量检索 · ${laneCount} 路`
        : `Batch search · ${laneCount} lane(s)`;

  const totalChip =
    view.aggregate != null
      ? isZh
        ? `共 ${view.aggregate.totalUniqueMatches} 条${view.aggregate.truncated ? '（截断）' : ''}`
        : `${view.aggregate.totalUniqueMatches} match(es)${view.aggregate.truncated ? ' (truncated)' : ''}`
      : isZh
        ? '检索中…'
        : 'searching…';

  const hasResults = view.aggregate != null && view.aggregate.matches.length > 0;

  return (
    <div
      className={`tool-call-card batch-search-card ${isRunning ? 'running' : 'done'}`}
      onClick={() => setExpanded(!expanded)}
    >
      <div className="tool-call-header">
        <span className="tool-call-label">{title}</span>
        <span className={`batch-search-total ${view.aggregate != null ? 'ready' : 'pending'}`}>
          {totalChip}
        </span>
        {hasResults ? (
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
        ) : null}
      </div>

      {laneCount > 0 ? (
        <ul className="batch-search-lanes">
          {view.lanes.map((lane) => {
            const cls = phaseClass(lane.phase);
            const showCount =
              lane.phase === 'completed' && typeof lane.resultCount === 'number';
            return (
              <li key={lane.laneId} className={`batch-search-lane ${cls}`}>
                <span className="batch-search-lane-dot" aria-hidden="true" />
                <span className="batch-search-lane-label">{lane.label || lane.query}</span>
                {showCount ? (
                  <span className="batch-search-lane-count">{lane.resultCount}</span>
                ) : (
                  <span className="batch-search-lane-state">
                    {lane.errorMessage ?? lanePhaseLabel(lane.phase, isZh)}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}

      {expanded && hasResults ? (
        <div className="batch-search-results">
          {view.aggregate!.matches.map((m) => (
            <div className="batch-search-result-row" key={`${m.path}:${m.line}`}>
              <div className="batch-search-result-loc">
                {m.path}:{m.line}
                {m.hitCount > 1 ? <span className="batch-search-result-hits"> ·{m.hitCount}×</span> : null}
              </div>
              <div className="batch-search-result-text">{m.text}</div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

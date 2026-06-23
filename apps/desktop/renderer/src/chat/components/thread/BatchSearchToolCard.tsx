import { useState } from 'react';
import {
  buildBatchSearchView,
  lanePhaseLabel,
  type BatchLanePhase,
} from '../../state/batchSearchLaneView';

/**
 * batch_search 工具卡：方向甲「极简单行折叠」。
 *
 * 默认只占一行：状态点 + 「批量检索 · N 路 · 共 M 条」+ 折叠箭头。
 * 点击整行展开，才显示分路（lanes）与聚合结果（results）。
 * 文案随 app i18n（isZh）。目标：克制、零留白、不抢戏。
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

  // 单行摘要：状态点 + 「批量检索 · N 路 · 共 M 条」。
  // 空壳兜底：lanes 尚未解析且运行中，显示"准备中"而不是"0 路"。
  const lanePart =
    laneCount === 0 && isRunning
      ? isZh
        ? '准备中…'
        : 'preparing…'
      : isZh
        ? `${laneCount} 路`
        : `${laneCount} lane(s)`;

  const matchPart =
    view.aggregate != null
      ? isZh
        ? `共 ${view.aggregate.totalUniqueMatches} 条${view.aggregate.truncated ? '（截断）' : ''}`
        : `${view.aggregate.totalUniqueMatches} match(es)${view.aggregate.truncated ? ' (truncated)' : ''}`
      : isZh
        ? '检索中…'
        : 'searching…';

  const lead = isZh ? '批量检索' : 'Batch search';
  const summary = `${lead} · ${lanePart} · ${matchPart}`;

  const phaseState = isRunning ? 'running' : view.status === 'failed' ? 'error' : 'done';
  const hasResults = view.aggregate != null && view.aggregate.matches.length > 0;
  const expandable = laneCount > 0 || hasResults;

  return (
    <div
      className={`tool-call-card batch-search-card ${phaseState}${expanded ? ' is-expanded' : ''}`}
      onClick={() => expandable && setExpanded(!expanded)}
    >
      <div className="batch-search-summary">
        <span className="batch-search-summary-dot" aria-hidden="true" />
        <span className="batch-search-summary-text">{summary}</span>
        {expandable ? (
          <svg
            className="batch-search-summary-caret"
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

      {expanded && laneCount > 0 ? (
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

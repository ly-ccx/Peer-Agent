import { useMemo, useState } from 'react';
import type { TaskOverviewItem } from '@peer-agent/protocol';
import { useTaskOverview } from '../hooks/useTaskOverview';
import { clientApi } from '../../clientApi';

/**
 * 任务页 —— 对齐 peer-2-0 高保真「Active Tasks」表格布局。
 *
 * collection-shell：
 * - topline（面包屑 + Workspace）
 * - collection-head（单行标题）
 * - collection-tools（状态筛选 chips + 搜索）
 * - task-table（任务 / 下一步行动 / GoalPlan / 更新 / 操作）
 *
 * 数据只消费 TaskOverviewItem 投影，不在前端解析状态机。
 */

type TasksFilter = 'all' | 'user' | 'peer' | 'review' | 'paused';

function workspaceLabelFromPath(workspacePath: string | null | undefined): string {
  if (!workspacePath) return '未绑定 Workspace';
  const seg = workspacePath.replace(/[/\\]+$/, '').split(/[/\\]/).filter(Boolean).pop();
  return seg || workspacePath;
}

function formatRelativeTime(iso?: string): string {
  if (!iso) return '刚刚';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const diffMs = Date.now() - t;
  if (diffMs < 60_000) return '刚刚';
  if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)} 分钟`;
  if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)} 小时`;
  if (diffMs < 2 * 86_400_000) return '昨天';
  if (diffMs < 7 * 86_400_000) return `${Math.floor(diffMs / 86_400_000)} 天前`;
  return new Date(t).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}

function progressPercent(item: TaskOverviewItem): number {
  const p = item.planProgress;
  if (!p || !p.total) return 0;
  return Math.max(0, Math.min(100, Math.round((p.completed / p.total) * 100)));
}

function filterKeyOf(item: TaskOverviewItem): Exclude<TasksFilter, 'all'> {
  if (item.source === 'conversation') return 'paused';
  switch (item.actionRight) {
    case 'needs_you':
      return 'user';
    case 'peer_advancing':
      return 'peer';
    case 'result_ready':
      return 'review';
    case 'paused':
      return 'paused';
    default:
      return 'peer';
  }
}

function sourceKindLabel(item: TaskOverviewItem): string {
  if (item.source === 'conversation') return '正在讨论';
  if (item.source === 'automation') return 'Automation';
  if (item.actionRight === 'result_ready') return 'Result ready';
  if (item.nextAction === 'approve_plan' || item.nextAction === 'confirm_scope') return 'Conversation';
  if (item.actionRight === 'peer_advancing') return 'Goal Runner';
  if (item.actionRight === 'needs_you') return 'Conversation';
  return 'Task';
}

function actionOwnerLabel(item: TaskOverviewItem): string {
  if (item.source === 'conversation') return item.statusLabel;
  if (item.actionRight === 'needs_you') {
    if (item.needsYouReason === 'plan_approval') return '等待你的决策';
    if (item.needsYouReason === 'user_input') {
      if (item.nextAction === 'grant_permission') return '等待权限';
      return '等待确认';
    }
    return '等待你的决策';
  }
  if (item.actionRight === 'result_ready') return '等待验收';
  if (item.actionRight === 'paused') return '已暂停';
  // peer_advancing
  const s = item.statusLabel;
  if (s.includes('验证')) return 'Peer 正在验证';
  if (s.includes('整理') || s.includes('生成')) return 'Peer 正在整理';
  if (s.includes('排队')) return 'Peer 排队中';
  return 'Peer 正在推进';
}

function rowOpenLabel(item: TaskOverviewItem): string {
  if (item.source === 'conversation') return item.actionLabel || '打开';
  if (item.actionRight === 'needs_you') {
    if (item.nextAction === 'grant_permission') return '处理 →';
    if (item.nextAction === 'decide_blocked' || item.nextAction === 'approve_plan') return '进入 →';
    return '进入 →';
  }
  if (item.actionRight === 'result_ready') return '验收 →';
  if (item.actionRight === 'paused') return '继续 →';
  return '查看 →';
}

export function TasksPage({
  workspacePath = null,
  onOpenItem,
}: {
  readonly workspacePath?: string | null;
  readonly onOpenItem?: (item: TaskOverviewItem) => void;
}) {
  const items = useTaskOverview({ workspacePath, includeTerminal: false });
  const activeItems = useMemo(
    () => items.filter((item) => item.actionRight !== 'terminal'),
    [items],
  );

  const [filter, setFilter] = useState<TasksFilter>('all');
  const [query, setQuery] = useState('');

  const counts = useMemo(() => {
    const base = { all: 0, user: 0, peer: 0, review: 0, paused: 0 };
    for (const item of activeItems) {
      base.all += 1;
      base[filterKeyOf(item)] += 1;
    }
    return base;
  }, [activeItems]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return activeItems.filter((item) => {
      if (filter !== 'all' && filterKeyOf(item) !== filter) return false;
      if (!q) return true;
      const hay = `${item.title} ${item.workspaceLabel ?? ''} ${item.statusLabel} ${actionOwnerLabel(item)}`.toLowerCase();
      return hay.includes(q);
    });
  }, [activeItems, filter, query]);

  const scopeLabel = workspaceLabelFromPath(workspacePath);

  return (
    <div className="task-overview-page task-overview-page--collection">
      <div className="task-overview-topline">
        <div className="task-overview-crumb">
          <b>任务</b>
          <span>/</span>
          <span>未结束的工作</span>
        </div>
        <div className="task-overview-scope">
          <i className="task-overview-scope-dot" aria-hidden="true" />
          当前 Workspace · {scopeLabel}
        </div>
      </div>

      <header className="task-collection-head">
        <h1>未结束的任务</h1>
      </header>

      <div className="task-collection-tools">
        <div className="task-filter-group" role="tablist" aria-label="任务状态筛选">
          {(
            [
              ['all', '全部'],
              ['user', '待我处理'],
              ['peer', 'Peer 推进中'],
              ['review', '待验收'],
              ['paused', '已暂停'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={filter === key}
              className={filter === key ? 'is-active' : undefined}
              onClick={() => setFilter(key)}
            >
              {label} <em>{counts[key]}</em>
            </button>
          ))}
        </div>
        <label className="task-search-box">
          <svg className="task-search-box__icon" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="11" cy="11" r="6.5" />
            <path d="m16 16 4 4" />
          </svg>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索任务"
            aria-label="搜索任务"
          />
        </label>
      </div>

      <div className="task-table">
        <div className="task-table-head" aria-hidden="true">
          <span>任务</span>
          <span>下一步行动</span>
          <span>GoalPlan</span>
          <span>更新</span>
          <span />
        </div>

        {visible.length === 0 ? (
          <div className="task-overview-empty task-table-empty">
            <p>{query.trim() ? '没有匹配的任务' : '没有进行中的任务'}</p>
          </div>
        ) : (
          visible.map((item) => {
            const status = filterKeyOf(item);
            const pct = progressPercent(item);
            return (
              <article key={item.taskId} className="task-record" data-status={status}>
                <div className="task-record-title">
                  <i className={`task-status-dot task-status-dot--${status}`} aria-hidden="true" />
                  <div>
                    <strong>{item.title}</strong>
                    <span>
                      {item.workspaceLabel ?? scopeLabel} · {sourceKindLabel(item)}
                    </span>
                  </div>
                </div>
                <span className={`task-action-owner task-action-owner--${status}`}>
                  {actionOwnerLabel(item)}
                </span>
                <div className="task-goal-progress">
                  <b>
                    {item.planProgress
                      ? `${item.planProgress.completed} / ${item.planProgress.total}`
                      : '—'}
                  </b>
                  <div aria-hidden="true">
                    <i style={{ width: item.planProgress ? `${pct}%` : '0%' }} />
                  </div>
                </div>
                <time>{formatRelativeTime(item.lastActiveAt)}</time>
                <button
                  type="button"
                  className="task-row-open"
                  onClick={() => onOpenItem?.(item)}
                >
                  {rowOpenLabel(item)}
                </button>
                {item.source === 'goal_plan' && item.actionRight === 'paused' ? (
                  <button
                    type="button"
                    className="task-row-abandon"
                    onClick={() => {
                      // goal_plan 项的 taskId 即 planId（投影 taskId: snapshot.planId）。
                      void clientApi.goalPlansDelete({ planId: item.taskId });
                    }}
                  >
                    放弃
                  </button>
                ) : null}
              </article>
            );
          })
        )}
      </div>
    </div>
  );
}

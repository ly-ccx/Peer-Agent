import { useMemo, useState } from 'react';
import type { TaskOverviewItem } from '@peer-agent/protocol';
import { useTaskOverview } from '../hooks/useTaskOverview';
import { ActionLabel } from './actionLabelDisplay';

/**
 * 历史页 —— 对齐 peer-2-0 高保真「Task History」终态列表。
 *
 * collection-shell：
 * - topline（面包屑 + scope）
 * - collection-head（单行标题）
 * - collection-tools（状态筛选 chips + 搜索）
 * - history-list / history-record（状态图标 / 标题 / 徽章 / Evidence 计数 / 操作）
 *
 * 数据只消费 TaskOverviewItem 投影。当前协议尚未单独建模 archived / Evidence 数，
 * 先用 statusLabel + planProgress 做可解释过渡映射。
 */

type HistoryFilter = 'all' | 'accepted' | 'archived' | 'cancelled' | 'failed';

function workspaceLabelFromPath(workspacePath: string | null | undefined): string {
  if (!workspacePath) return '未绑定 Workspace';
  const seg = workspacePath.replace(/[/\\]+$/, '').split(/[/\\]/).filter(Boolean).pop();
  return seg || workspacePath;
}

function formatHistoryDate(iso?: string): string {
  if (!iso) return '近期结束';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const d = new Date(t);
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

function historyKindOf(item: TaskOverviewItem): Exclude<HistoryFilter, 'all'> {
  const label = item.statusLabel ?? '';
  if (label.includes('失败') || label.includes('超时') || label.includes('阻塞')) return 'failed';
  if (label.includes('取消') || label.includes('跳过')) return 'cancelled';
  if (label.includes('归档') || (label.includes('已完成') && item.source === 'automation')) return 'archived';
  if (label.includes('完成') || label.includes('验收') || label.includes('已验收')) return 'accepted';
  return 'accepted';
}

function historyBadge(kind: Exclude<HistoryFilter, 'all'>): string {
  switch (kind) {
    case 'accepted':
      return '已完成';
    case 'archived':
      return '已归档';
    case 'cancelled':
      return '已取消';
    case 'failed':
      return '失败';
  }
}

function historyIcon(kind: Exclude<HistoryFilter, 'all'>): string {
  switch (kind) {
    case 'accepted':
      return '✓';
    case 'archived':
      return '□';
    case 'cancelled':
      return '×';
    case 'failed':
      return '!';
  }
}

function historyVerb(kind: Exclude<HistoryFilter, 'all'>): string {
  switch (kind) {
    case 'accepted':
      return '完成';
    case 'archived':
      return '归档';
    case 'cancelled':
      return '结束';
    case 'failed':
      return '结束';
  }
}

function evidenceLabel(item: TaskOverviewItem, kind: Exclude<HistoryFilter, 'all'>): string {
  if (kind === 'cancelled') return '保留决策记录';
  if (kind === 'failed') {
    return item.planProgress ? `${item.planProgress.completed} 条错误证据` : '1 条错误证据';
  }
  if (kind === 'archived') {
    return item.planProgress ? `${item.planProgress.total} 个 Artifact` : 'Artifact 已保留';
  }
  if (item.planProgress?.total) return `${item.planProgress.total} 条 Evidence`;
  return 'Evidence 可复核';
}

function rowOpenLabel(kind: Exclude<HistoryFilter, 'all'>): string {
  switch (kind) {
    case 'accepted':
      return '查看结果';
    case 'archived':
      return '继续讨论';
    case 'cancelled':
      return '查看记录';
    case 'failed':
      return '重新开始';
  }
}

function rowOpenShowsArrow(kind: Exclude<HistoryFilter, 'all'>): boolean {
  return kind === 'accepted' || kind === 'cancelled';
}

export function HistoryPage({ workspacePath = null }: { readonly workspacePath?: string | null }) {
  const items = useTaskOverview({ workspacePath, includeTerminal: true });
  const terminalItems = useMemo(
    () => items.filter((item) => item.actionRight === 'terminal'),
    [items],
  );

  const [filter, setFilter] = useState<HistoryFilter>('all');
  const [query, setQuery] = useState('');

  const counts = useMemo(() => {
    const base = { all: 0, accepted: 0, archived: 0, cancelled: 0, failed: 0 };
    for (const item of terminalItems) {
      base.all += 1;
      base[historyKindOf(item)] += 1;
    }
    return base;
  }, [terminalItems]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return terminalItems.filter((item) => {
      const kind = historyKindOf(item);
      if (filter !== 'all' && kind !== filter) return false;
      if (!q) return true;
      const hay = `${item.title} ${item.workspaceLabel ?? ''} ${historyBadge(kind)} ${evidenceLabel(item, kind)}`.toLowerCase();
      return hay.includes(q);
    });
  }, [terminalItems, filter, query]);

  const scopeLabel = workspaceLabelFromPath(workspacePath);

  return (
    <div className="task-overview-page task-overview-page--collection">
      <div className="task-overview-topline">
        <div className="task-overview-crumb">
          <b>历史</b>
          <span>/</span>
          <span>终态任务</span>
        </div>
        <div className="task-overview-scope">保留 Artifact 与 Evidence</div>
      </div>

      <header className="task-collection-head">
        <h1>已经结束的任务</h1>
      </header>

      <div className="task-collection-tools">
        <div className="task-filter-group" role="tablist" aria-label="历史状态筛选">
          {(
            [
              ['all', '全部'],
              ['accepted', '已完成'],
              ['archived', '已归档'],
              ['cancelled', '已取消'],
              ['failed', '失败'],
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
            placeholder="搜索历史"
            aria-label="搜索历史"
          />
        </label>
      </div>

      <div className="history-list">
        {visible.length === 0 ? (
          <div className="task-overview-empty history-list-empty">
            <p>{query.trim() ? '没有匹配的历史记录' : '暂无历史记录'}</p>
          </div>
        ) : (
          visible.map((item) => {
            const kind = historyKindOf(item);
            return (
              <article key={item.taskId} className="history-record" data-status={kind}>
                <div className={`history-state history-state--${kind}`} aria-hidden="true">
                  {historyIcon(kind)}
                </div>
                <div className="history-record-title">
                  <strong>{item.title}</strong>
                  <span>
                    {item.workspaceLabel ?? scopeLabel} · {formatHistoryDate(item.lastActiveAt)}
                    {historyVerb(kind)}
                  </span>
                </div>
                <span className={`history-badge history-badge--${kind}`}>{historyBadge(kind)}</span>
                <span className="history-evidence-count">{evidenceLabel(item, kind)}</span>
                <button type="button" className="history-row-open">
                  <ActionLabel label={rowOpenLabel(kind)} forceArrow={rowOpenShowsArrow(kind)} />
                </button>
              </article>
            );
          })
        )}
      </div>
    </div>
  );
}

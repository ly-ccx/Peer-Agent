import { useCallback, useMemo } from 'react';
import type { TaskOverviewItem } from '@peer-agent/protocol';
import { formatDuration } from '../../chat/state/format';
import { useWorkbenchOptional } from '../../workbench/WorkbenchContext';
import { useTaskOverview } from '../hooks/useTaskOverview';

/**
 * 总工作台（跨工作区 Action Inbox）—— 与区级 TaskOverviewPage 完全独立。
 *
 * 只在侧栏顶部「工作台」入口（workspacePath = null）挂载。
 * 区级工作台仍走 HomePage → TaskOverviewPage，互不污染。
 */
export function GlobalWorkbenchPage({
  onOpenTasks,
  onOpenHistory,
  onNewTask,
  onOpenItem,
  onAcceptResult,
  onCancelItem,
}: {
  readonly onOpenTasks?: () => void;
  readonly onOpenHistory?: () => void;
  readonly onNewTask?: () => void;
  readonly onOpenItem?: (item: TaskOverviewItem) => void;
  readonly onAcceptResult?: (item: TaskOverviewItem) => void | Promise<void>;
  readonly onCancelItem?: (item: TaskOverviewItem) => void | Promise<void>;
}) {
  const workbench = useWorkbenchOptional();
  // 全局拉数：不传 workspacePath。
  const items = useTaskOverview({ workspacePath: null, includeTerminal: false });

  const handleOpenItem = useCallback((item: TaskOverviewItem) => {
    if (
      item.source === 'shell_background' ||
      item.nextAction === 'open_background_thread'
    ) {
      workbench?.openBackgroundThread(item.taskId);
      return;
    }
    onOpenItem?.(item);
  }, [onOpenItem, workbench]);

  const needsYou = useMemo(
    () => items.filter((i) => i.source !== 'conversation' && i.actionRight === 'needs_you'),
    [items],
  );
  const resultReady = useMemo(
    () => items.filter((i) => i.source !== 'conversation' && i.actionRight === 'result_ready'),
    [items],
  );
  const advancing = useMemo(
    () => items.filter((i) => i.source !== 'conversation' && i.actionRight === 'peer_advancing'),
    [items],
  );
  const discussions = useMemo(
    () => items.filter((i) => i.source === 'conversation').slice(0, 3),
    [items],
  );
  const discussionTotal = useMemo(
    () => items.filter((i) => i.source === 'conversation').length,
    [items],
  );

  const actionCount = needsYou.length + resultReady.length;
  const showEmpty = actionCount === 0 && advancing.length === 0 && discussionTotal === 0;

  // 工作区脉搏：按 workspaceLabel 聚合
  const pulse = useMemo(() => {
    const map = new Map<string, { need: number; run: number; accept: number }>();
    for (const item of items) {
      if (item.source === 'conversation') continue;
      const key = item.workspaceLabel?.trim() || '未标注工作区';
      const row = map.get(key) ?? { need: 0, run: 0, accept: 0 };
      if (item.actionRight === 'needs_you') row.need += 1;
      else if (item.actionRight === 'peer_advancing') row.run += 1;
      else if (item.actionRight === 'result_ready') row.accept += 1;
      map.set(key, row);
    }
    return [...map.entries()]
      .map(([name, counts]) => ({ name, ...counts, total: counts.need + counts.run + counts.accept }))
      .filter((r) => r.total > 0)
      .sort((a, b) => b.need - a.need || b.accept - a.accept || b.run - a.run)
      .slice(0, 6);
  }, [items]);

  return (
    <div className="gwb-page">
      <div className="gwb-shell">
        <header className="gwb-hero">
          <div className="gwb-hero-copy">
            <div className="gwb-eyebrow">全部工作区</div>
            <h1>工作台</h1>
            <p>汇总待你处理的决策、权限与验收。其余由 Peer 推进。</p>
          </div>
          <div className="gwb-calm-card">
            <div className="gwb-calm-dot" aria-hidden="true" />
            <b>{advancing.length} 个任务在推进</b>
            <span>{actionCount === 0 ? '无需你介入' : 'Peer 会在交接点叫你'}</span>
          </div>
        </header>

        <div className="gwb-layout">
          <div className="gwb-main">
            {showEmpty ? (
              <div className="gwb-empty">
                <p>现在没有需要你处理的事</p>
                {advancing.length > 0 ? (
                  <p className="gwb-empty-hint">{advancing.length} 个任务由 Peer 推进中</p>
                ) : null}
                {onNewTask ? (
                  <button type="button" className="gwb-btn gwb-btn-primary" onClick={onNewTask}>
                    发起新任务
                  </button>
                ) : null}
              </div>
            ) : null}

            {needsYou.length > 0 ? (
              <section className="gwb-panel">
                <div className="gwb-panel-head">
                  <div>
                    <h2>需要你</h2>
                    <div className="gwb-sub">{needsYou.length} 项 · 决策 / 权限</div>
                  </div>
                </div>
                <div className="gwb-list">
                  {needsYou.map((item) => (
                    <InboxRow
                      key={item.taskId}
                      item={item}
                      kind="need"
                      onOpen={() => handleOpenItem(item)}
                    />
                  ))}
                </div>
              </section>
            ) : null}

            {resultReady.length > 0 ? (
              <section className="gwb-panel">
                <div className="gwb-panel-head">
                  <div>
                    <h2>待验收</h2>
                    <div className="gwb-sub">{resultReady.length} 项</div>
                  </div>
                  {onOpenHistory ? (
                    <button type="button" className="gwb-link" onClick={onOpenHistory}>
                      查看历史 →
                    </button>
                  ) : null}
                </div>
                <div className="gwb-list">
                  {resultReady.map((item) => (
                    <InboxRow
                      key={item.taskId}
                      item={item}
                      kind="accept"
                      onOpen={() => handleOpenItem(item)}
                      onAccept={
                        onAcceptResult
                          ? () => {
                              void onAcceptResult(item);
                            }
                          : undefined
                      }
                    />
                  ))}
                </div>
              </section>
            ) : null}
          </div>

          <aside className="gwb-side">
            <section className="gwb-panel">
              <div className="gwb-panel-head">
                <div>
                  <div className="gwb-side-label">PEER 推进</div>
                  <div className="gwb-side-count">{advancing.length} 个任务</div>
                </div>
                {onOpenTasks ? (
                  <button type="button" className="gwb-link" onClick={onOpenTasks}>
                    查看全部 →
                  </button>
                ) : null}
              </div>
              {advancing.length === 0 ? (
                <div className="gwb-side-empty">当前没有推进中的任务</div>
              ) : (
                <div className="gwb-run-list">
                  {advancing.slice(0, 6).map((item) => (
                    <button
                      key={item.taskId}
                      type="button"
                      className="gwb-run-row"
                      onClick={() => handleOpenItem(item)}
                    >
                      <span className="gwb-run-dot" aria-hidden="true" />
                      <span className="gwb-run-copy">
                        <span className="gwb-run-title">{item.title}</span>
                        <span className="gwb-run-sub">
                          {[item.workspaceLabel, item.statusLabel].filter(Boolean).join(' · ')}
                        </span>
                      </span>
                      {item.planProgress ? (
                        <span className="gwb-run-pct">
                          {item.planProgress.completed}/{item.planProgress.total}
                        </span>
                      ) : null}
                    </button>
                  ))}
                </div>
              )}
            </section>

            {pulse.length > 0 ? (
              <section className="gwb-pulse">
                <div className="gwb-pulse-head">
                  <b>工作区脉搏</b>
                  <span>按来源工作区汇总</span>
                </div>
                {pulse.map((row) => (
                  <div key={row.name} className="gwb-pulse-row">
                    <span className="gwb-pulse-name">{row.name}</span>
                    <span className={row.need > 0 ? 'gwb-num gwb-num-alert' : 'gwb-num'}>
                      {row.need} 需你
                    </span>
                    <span className="gwb-num">{row.run} 推进</span>
                    <span className={row.accept > 0 ? 'gwb-num gwb-num-ok' : 'gwb-num'}>
                      {row.accept} 验收
                    </span>
                  </div>
                ))}
              </section>
            ) : null}

            {discussions.length > 0 ? (
              <section className="gwb-panel gwb-soft">
                <div className="gwb-panel-head">
                  <div className="gwb-side-label">最近讨论</div>
                  <div className="gwb-side-meta">
                    预览 {discussions.length}
                    {discussionTotal > discussions.length ? ` / ${discussionTotal}` : ''}
                  </div>
                </div>
                <div className="gwb-run-list">
                  {discussions.map((item) => (
                    <button
                      key={item.taskId}
                      type="button"
                      className="gwb-run-row"
                      onClick={() => handleOpenItem(item)}
                    >
                      <span className="gwb-run-copy">
                        <span className="gwb-run-title">{item.title}</span>
                        <span className="gwb-run-sub">
                          {[item.workspaceLabel, formatRelativeTime(item.lastActiveAt)]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            ) : null}
          </aside>
        </div>
      </div>
    </div>
  );
}

function InboxRow({
  item,
  kind,
  onOpen,
  onAccept,
}: {
  readonly item: TaskOverviewItem;
  readonly kind: 'need' | 'accept';
  readonly onOpen: () => void;
  readonly onAccept?: () => void;
}) {
  const tag =
    kind === 'accept'
      ? '验收'
      : item.nextAction === 'grant_permission'
        ? '权限'
        : item.needsYouReason === 'decision' || item.nextAction === 'approve_plan'
          ? '决策'
          : '需要你';
  const cta =
    kind === 'accept'
      ? '验收结果'
      : item.actionLabel || '去处理';
  const durationLabel =
    typeof item.durationMs === 'number' &&
    Number.isFinite(item.durationMs) &&
    item.durationMs >= 0
      ? formatDuration(item.durationMs)
      : undefined;
  const timeLabel = item.completedAt
    ? formatRelativeTime(item.completedAt)
    : formatRelativeTime(item.lastActiveAt);

  return (
    <div className="gwb-item">
      <div className="gwb-type">
        <span className={`gwb-tag gwb-tag-${kind === 'accept' ? 'accept' : 'need'}`}>{tag}</span>
        <span className="gwb-type-note">{item.statusLabel}</span>
      </div>
      <div className="gwb-body">
        <div className="gwb-title">{item.title}</div>
        {item.currentGoalTitle ? (
          <div className="gwb-desc">当前 · {item.currentGoalTitle}</div>
        ) : null}
        <div className="gwb-chips">
          {item.workspaceLabel ? (
            <span className="gwb-chip gwb-chip-ws">{item.workspaceLabel}</span>
          ) : null}
          {item.planProgress ? (
            <span className="gwb-chip">
              {item.planProgress.completed} / {item.planProgress.total}
            </span>
          ) : null}
          {durationLabel ? (
            <span className="gwb-chip gwb-chip-duration">耗时 {durationLabel}</span>
          ) : null}
          <span className="gwb-chip">{timeLabel}</span>
        </div>
      </div>
      <div className="gwb-actions">
        {kind === 'accept' && onAccept ? (
          <>
            <button type="button" className="gwb-btn gwb-btn-ghost" onClick={onOpen}>
              查看
            </button>
            <button type="button" className="gwb-btn gwb-btn-primary" onClick={onAccept}>
              确认验收
            </button>
          </>
        ) : (
          <button type="button" className="gwb-btn gwb-btn-primary" onClick={onOpen}>
            {cta}
          </button>
        )}
      </div>
    </div>
  );
}

function formatRelativeTime(iso?: string): string {
  if (!iso) return '刚刚';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const diffMs = Date.now() - t;
  if (diffMs < 60_000) return '刚刚';
  if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)} 分钟前`;
  if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)} 小时前`;
  if (diffMs < 7 * 86_400_000) return `${Math.floor(diffMs / 86_400_000)} 天前`;
  return new Date(t).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}

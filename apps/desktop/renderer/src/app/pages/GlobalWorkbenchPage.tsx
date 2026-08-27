import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import type { TaskOverviewItem } from '@peer-agent/protocol';
import { ThinkingOrb } from 'thinking-orbs';
import { prefersReducedMotion } from '../hooks/useMotionPresence';
import type { OpenTaskOverviewItem } from '../state/resultDrawerAcceptance';
import { formatDuration } from '../../chat/state/format';
import { clientApi } from '../../clientApi';
import { useWorkbenchOptional } from '../../workbench/WorkbenchContext';
import { useTaskOverview } from '../hooks/useTaskOverview';
import { ThreadList, type ThreadListNode } from './goalThreadGrouping';
import {
  type AcceptancePhase,
} from '../state/acceptanceTransition';
import { ParticleShatterOverlay } from '../fx/ParticleShatterOverlay';
import { useShatterExitCollapse } from '../fx/useShatterExitCollapse';
import { PeerIcon } from '../../ui/icons';
import { isWorkbenchHandoffCard, SourceCheckoutPanel } from '../components/SourceCheckoutPanel';
import { ActionLabel } from './actionLabelDisplay';

function workspaceBasename(workspacePath: string): string {
  const normalized = workspacePath.replace(/[/\\]+$/, '');
  const parts = normalized.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] || normalized;
}

/**
 * 总工作台（跨工作区 Action Inbox）—— 与区级 TaskOverviewPage 完全独立。
 *
 * 只在侧栏顶部「工作台」入口（workspacePath = null）挂载。
 * 区级工作台仍走 HomePage → TaskOverviewPage，互不污染。
 */
type AcceptanceTransition = {
  readonly item: TaskOverviewItem;
  readonly phase: AcceptancePhase;
};

export function GlobalWorkbenchPage({
  onOpenTasks,
  onOpenHistory,
  onNewTask,
  onOpenItem,
  onAcceptResult,
  acceptHandlerRef,
  onCancelItem,
  onOpenWorkspace,
  enabled = true,
}: {
  readonly onOpenTasks?: () => void;
  readonly onOpenHistory?: () => void;
  readonly onNewTask?: () => void;
  readonly onOpenItem?: OpenTaskOverviewItem;
  readonly onAcceptResult?: (item: TaskOverviewItem) => void | Promise<void>;
  readonly acceptHandlerRef?: MutableRefObject<((item: TaskOverviewItem) => void | Promise<void>) | null>;
  readonly onCancelItem?: (item: TaskOverviewItem) => void | Promise<void>;
  /** 点击「工作区脉搏」行：切到对应区级工作台。 */
  readonly onOpenWorkspace?: (workspacePath: string) => void;
  readonly enabled?: boolean;
}) {
  const workbench = useWorkbenchOptional();
  // 全局拉数：不传 workspacePath。Drawer 覆盖时暂停底页刷新。
  const items = useTaskOverview({ enabled, workspacePath: null, includeTerminal: false });

  const handleOpenItem = useCallback<OpenTaskOverviewItem>((item, options) => {
    if (isWorkbenchHandoffCard(item)) return;
    if (
      item.source === 'shell_background' ||
      item.nextAction === 'open_background_thread'
    ) {
      workbench?.openBackgroundThread(item.taskId);
      return;
    }
    onOpenItem?.(item, options);
  }, [onOpenItem, workbench]);

  // 脉搏行只暴露 workspaceLabel（basename）。点击时用 workspaceList 反查 path，
  // 并先 workspaceSetActive，行为对齐侧栏点击工作区。
  const handleOpenPulseWorkspace = useCallback(async (workspaceLabel: string) => {
    if (!onOpenWorkspace) return;
    const label = workspaceLabel.trim();
    if (!label) return;
    try {
      const result = await clientApi.workspaceList();
      const match = result.workspaces.find((ws) => {
        if (ws.name === label) return true;
        return workspaceBasename(ws.path) === label;
      });
      if (!match) return;
      if (result.activeWorkspace !== match.path) {
        await clientApi.workspaceSetActive({ path: match.path });
      }
      onOpenWorkspace(match.path);
    } catch {
      // 工作区列表不可用时静默失败，避免打断总工作台浏览。
    }
  }, [onOpenWorkspace]);

  const needsYou = useMemo(
    () => items.filter((i) => i.source !== 'conversation' && i.actionRight === 'needs_you'),
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

  const actionCount = needsYou.length;
  // 主列只承载「待你处理」。无待办时仍占满主列高度，做成安静雷达面；
  // 推进与讨论留在右侧，不把空态做成居中单列。
  const showEmpty = actionCount === 0;

  // 工作区脉搏：按 workspaceLabel 聚合需你 / 推进。Goal 完成即终态，不再计验收。
  const pulse = useMemo(() => {
    const map = new Map<string, { need: number; run: number }>();
    for (const item of items) {
      if (item.source === 'conversation') continue;
      const key = item.workspaceLabel?.trim() || '未标注工作区';
      const row = map.get(key) ?? { need: 0, run: 0 };
      if (item.actionRight === 'needs_you') row.need += 1;
      else if (item.actionRight === 'peer_advancing') row.run += 1;
      map.set(key, row);
    }
    return [...map.entries()]
      .map(([name, counts]) => ({ name, ...counts, total: counts.need + counts.run }))
      .filter((r) => r.total > 0)
      .sort((a, b) => b.need - a.need || b.run - a.run)
      .slice(0, 6);
  }, [items]);

  return (
    <div className="gwb-page">
      <div className="gwb-shell">
        <header className="gwb-hero">
          <div className="gwb-hero-copy">
            <div className="gwb-eyebrow">全部工作区</div>
            <h1>工作台</h1>
            <p>汇总待你处理的选项、决策与权限。其余由 Peer 推进。</p>
          </div>
        </header>

        <div className={`gwb-layout${showEmpty ? ' gwb-layout--empty' : ''}`}>
          <div className="gwb-main">
            {showEmpty ? (
              <div className="gwb-empty">
                <p>现在没有需要你处理的事</p>
                {advancing.length > 0 ? (
                  <p className="gwb-empty-hint">
                    Peer 正在推进 {advancing.length} 个任务，你可以离开。
                  </p>
                ) : (
                  <p className="gwb-empty-hint">雷达是安静的。其余由 Peer 推进。</p>
                )}
                {onNewTask ? (
                  <button type="button" className="gwb-btn gwb-btn-primary" onClick={onNewTask}>
                    发起新任务
                  </button>
                ) : null}
              </div>
            ) : null}

            {needsYou.length > 0 ? (
              <section className="gwb-panel">
                <div className="gwb-panel-head gwb-side-head">
                  <div className="gwb-side-head-left">
                    <span className="gwb-side-label">需要你</span>
                    <span className="gwb-side-count">{needsYou.length} 项 · 选项 / 决策 / 权限</span>
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

          </div>

          <aside className="gwb-side">
            <section className="gwb-panel">
              <div className="gwb-panel-head gwb-side-head">
                <div className="gwb-side-head-left">
                  <span className="gwb-side-label">PEER 推进</span>
                  <span className="gwb-side-count">{advancing.length} 个任务</span>
                </div>
                {onOpenTasks ? (
                  <button type="button" className="gwb-link" onClick={onOpenTasks}>
                    查看全部
                    <PeerIcon name="chevronRight" size={14} className="gwb-link-arrow" />
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
                      <span className="gwb-run-dot" aria-hidden="true">
                        <ThinkingOrb
                          state="weaving"
                          size={20}
                          aria-label="Peer 正在推进"
                          paused={prefersReducedMotion()}
                        />
                      </span>
                      <span className="gwb-run-copy">
                        <span className="gwb-run-title">{item.title}</span>
                        <span className="gwb-run-sub">
                          {[item.workspaceLabel, item.statusLabel].filter(Boolean).join(' · ')}
                        </span>
                      </span>
                      {item.planProgress ? (
                        <span className="gwb-run-pct" aria-live="polite" aria-atomic="true">
                          <span
                            key={`${item.planProgress.completed}/${item.planProgress.total}`}
                            className="gwb-run-pct-value"
                          >
                            {item.planProgress.completed}/{item.planProgress.total}
                          </span>
                        </span>
                      ) : null}
                    </button>
                  ))}
                </div>
              )}
            </section>

            {pulse.length > 0 ? (
              <section className="gwb-panel gwb-pulse">
                <div className="gwb-panel-head gwb-side-head">
                  <div className="gwb-side-head-left">
                    <span className="gwb-side-label">工作区脉搏</span>
                  </div>
                  <span className="gwb-side-meta">按来源工作区汇总</span>
                </div>
                <div className="gwb-pulse-body">
                  {pulse.map((row) => (
                    <button
                      key={row.name}
                      type="button"
                      className="gwb-pulse-row"
                      onClick={() => {
                        void handleOpenPulseWorkspace(row.name);
                      }}
                      title={`打开 ${row.name} 工作台`}
                    >
                      <span className="gwb-pulse-name">{row.name}</span>
                      <span className={row.need > 0 ? 'gwb-num gwb-num-alert' : 'gwb-num'}>
                        {row.need} 需你
                      </span>
                      <span className="gwb-num">{row.run} 推进</span>
                    </button>
                  ))}
                </div>
              </section>
            ) : null}

            {discussions.length > 0 ? (
              <section className="gwb-panel gwb-soft">
                <div className="gwb-panel-head gwb-side-head">
                  <div className="gwb-side-head-left">
                    <span className="gwb-side-label">最近讨论</span>
                  </div>
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
  phase = null,
  onOpen,
  threadNodes,
  threadPendingCount,
  onOpenThreadNode,
}: {
  readonly item: TaskOverviewItem;
  readonly kind: 'need' | 'accept';
  readonly phase?: AcceptancePhase | null;
  readonly onOpen: () => void;
  readonly threadNodes?: readonly ThreadListNode[];
  readonly threadPendingCount?: number;
  readonly onOpenThreadNode?: (item: TaskOverviewItem) => void;
}) {
  const [sourceOpen, setSourceOpen] = useState(false);
  const sourceBlock = kind === 'need'
    && Boolean(item.deliveryHandoffStoppedReason)
    && isWorkbenchHandoffCard(item);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  useShatterExitCollapse(kind === 'accept' ? phase : null, hostRef);
  const submitting = phase === 'submitting';
  const celebrating = phase === 'celebrating' || phase === 'exiting';
  const shattering = kind === 'accept' && celebrating;
  const acceptBusy = submitting || celebrating;

  const tag =
    kind === 'accept'
      ? celebrating
        ? '已验收'
        : '验收'
      : item.nextAction === 'grant_permission'
        ? '权限'
        : item.needsYouReason === 'decision' || item.nextAction === 'approve_plan'
          ? '决策'
          : '需要你';

  const typeNote =
    kind === 'accept'
      ? celebrating
        ? '验收完成'
        : submitting
          ? '提交中'
          : threadPendingCount && threadPendingCount > 1
            ? `${item.statusLabel || '等待验收'} · ${threadPendingCount} 项待签`
            : item.statusLabel || '等待验收'
      : sourceBlock
        ? `${item.blockedPlanIds?.length || 1} 件事`
        : item.statusLabel;

  const cta =
    kind === 'accept'
      ? submitting
        ? '正在合进源头…'
        : celebrating
          ? '已归档 ✓'
          : '查看进度'
      : sourceBlock
        ? (sourceOpen ? '收起' : '处理')
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
    <div
      ref={hostRef}
      className={`particle-shatter-host${kind === 'accept' && phase ? ` gwb-item-host--${phase}` : ''}${
        kind === 'accept' && phase === 'exiting' ? ' is-exiting' : ''
      }`}
    >
      <div
        ref={cardRef}
        className={`gwb-item particle-shatter-source${shattering ? ' is-shattering' : ''}${
          kind === 'accept' && phase === 'submitting' ? ' gwb-item--submitting' : ''
        }${sourceBlock && sourceOpen ? ' gwb-item--source-open' : ''}`}
      >
        <div className="gwb-type">
          <span className={`gwb-tag gwb-tag-${kind === 'accept' ? 'accept' : 'need'}`}>{tag}</span>
          <span className="gwb-type-note">{typeNote}</span>
        </div>
        <div className="gwb-body">
          <div className="gwb-title">{item.title}</div>
          {sourceBlock ? (
            <div className="gwb-desc">
              {item.currentGoalTitle || '挡住它们的是这条线上的未提交改动'}
            </div>
          ) : item.currentGoalTitle ? (
            <div className="gwb-desc">当前 · {item.currentGoalTitle}</div>
          ) : null}
          <div className="gwb-chips">
            {item.workspaceLabel ? (
              <span className="gwb-chip gwb-chip-ws">{item.workspaceLabel}</span>
            ) : null}
            {sourceBlock ? (
              <span className="gwb-chip">{item.blockedPlanIds?.length || 1} 件事</span>
            ) : item.planProgress ? (
              <span className="gwb-chip">
                {item.planProgress.completed} / {item.planProgress.total}
              </span>
            ) : null}
            {!sourceBlock && durationLabel ? (
              <span className="gwb-chip gwb-chip-duration">耗时 {durationLabel}</span>
            ) : null}
            <span className="gwb-chip">{timeLabel}</span>
          </div>
          {threadNodes && threadNodes.length > 0 ? (
            <ThreadList nodes={threadNodes} currentId={item.taskId} onOpenItem={onOpenThreadNode} />
          ) : null}
        </div>
        <div className="gwb-actions">
          <button
            type="button"
            className="gwb-btn gwb-btn-primary"
            onClick={sourceBlock ? () => setSourceOpen((open) => !open) : onOpen}
            disabled={kind === 'accept' && acceptBusy}
          >
            {kind === 'accept' && submitting ? <span className="gwb-accept-spinner" aria-hidden="true" /> : null}
            <ActionLabel label={cta} />
            {kind !== 'accept' && item.nextAction === 'decide_blocked' && !cta.includes('→') ? <ActionArrowIcon /> : null}
          </button>
        </div>
        {sourceBlock && sourceOpen ? <SourceCheckoutPanel item={item} /> : null}
      </div>
      {kind === 'accept' ? (
        <ParticleShatterOverlay active={shattering} targetRef={cardRef} />
      ) : null}
    </div>
  );
}

function ActionArrowIcon() {
  return (
    <svg
      className="gwb-btn-arrow"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
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

import { createI18n } from '@peer-agent/i18n';
import type { TaskOverviewArtifact, TaskOverviewItem } from '@peer-agent/protocol';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChatHeaderCapabilities } from '../../chat/components/thread/ChatHeaderCapabilities';
import { useLocalAccessPreference } from '../../chat/hooks/useLocalAccessPreference';
import { formatDuration } from '../../chat/state/format';
import { clientApi } from '../../clientApi';
import { PeerIcon } from '../../ui/icons';
import { ActionLabel } from './actionLabelDisplay';
import {
  ACCEPTANCE_CELEBRATION_MS,
  ACCEPTANCE_EXIT_MS,
  mergeAcceptanceTransitionItems,
  type AcceptancePhase,
} from '../state/acceptanceTransition';
import {
  type OpenTaskOverviewItem,
} from '../state/resultDrawerAcceptance';
import { ParticleShatterOverlay } from '../fx/ParticleShatterOverlay';
import { useShatterExitCollapse } from '../fx/useShatterExitCollapse';
import { useTaskOverview } from '../hooks/useTaskOverview';
import { projectTaskOverviewArtifacts } from './taskOverviewArtifacts';
import { availablePreviewSize, positionTaskArtifactPreview } from './taskArtifactPreviewPosition';
import { buildDiffLines } from '../../workbench/file-preview/DiffViewer';
import {
  buildThreadListNodes,
  groupResultCardsByGoalThread,
  ThreadList,
  type ThreadListNode,
} from './goalThreadGrouping';
import { groupInboxByConversation } from './inboxConversationGrouping';

/**
 * TaskOverview 页面 —— Action Inbox。
 *
 * 工作台首页只回答三件事：需要你（遇选项）、正在推进、未读。
 * Goal 完成即终态，不再设「结果待验收」。
 *
 * 任务/历史页：统一列表（也可由 Drawer 承载）。
 * 行动权分桶只消费 TaskOverviewItem.actionRight，前端不解析状态机。
 *
 * 未读：只展示会话里尚未看过的沟通，不等于验收。
 *
 * 侧栏语义：工作台固定全局（workspacePath=null）；
 * 任务/历史抽屉可按 workspacePath 收窄。下方工作区点击只激活落点，不改工作台数据边界。
 */

interface TaskOverviewPageProps {
  readonly title: string;
  readonly subtitle?: string;
  readonly filter: (item: TaskOverviewItem) => boolean;
  readonly emptyLabel?: string;
  readonly hero?: boolean;
  /** 传给聚合层的过滤 path；null/undefined = 全局。 */
  readonly workspacePath?: string | null;
  readonly includeTerminal?: boolean;
  readonly enabled?: boolean;
  readonly onOpenTasks?: () => void;
  readonly onOpenHistory?: () => void;
  /** 空态「发起新任务」：跳到新建任务页。 */
  readonly onNewTask?: () => void;
  /** 打开对应会话（决策 / 查看进度）。归组卡可带上同线待签项。 */
  readonly onOpenItem?: OpenTaskOverviewItem;
  /** 遗留：验收入口已取消，保留 prop 以免调用方断裂。 */
  readonly onAcceptResult?: (item: TaskOverviewItem) => void | Promise<void>;
  readonly acceptHandlerRef?: MutableRefObject<((item: TaskOverviewItem) => void | Promise<void>) | null>;
  /** 取消正在推进的 GoalPlan（仅 goal_plan）。 */
  readonly onCancelItem?: (item: TaskOverviewItem) => void | Promise<void>;
  /** 区级摘要跳到侧栏「插件」页。 */
  readonly onOpenTools?: () => void;
}

function workspaceLabelFromPath(workspacePath: string | null | undefined): string {
  if (!workspacePath) return '全部工作区';
  const seg = workspacePath.replace(/[/\\]+$/, '').split(/[/\\]/).filter(Boolean).pop();
  return seg || workspacePath;
}

function scopeDisplayLabel(workspacePath: string | null | undefined): string {
  if (!workspacePath) return '全部工作区';
  return `Workspace · ${workspaceLabelFromPath(workspacePath)}`;
}

/** 相对时间；completed 模式用于历史完成卡片「何时完成」。 */
function formatRelativeTime(iso?: string, options?: { readonly completed?: boolean }): string {
  const completed = options?.completed === true;
  if (!iso) return completed ? '刚刚完成' : '刚刚更新';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const diffMs = Date.now() - t;
  if (diffMs < 60_000) return completed ? '刚刚完成' : '刚刚更新';
  if (diffMs < 3_600_000) {
    const minutes = Math.floor(diffMs / 60_000);
    return completed ? `${minutes} 分钟前完成` : `${minutes} 分钟前`;
  }
  if (diffMs < 86_400_000) {
    const hours = Math.floor(diffMs / 3_600_000);
    return completed ? `${hours} 小时前完成` : `${hours} 小时前`;
  }
  if (diffMs < 7 * 86_400_000) {
    const days = Math.floor(diffMs / 86_400_000);
    return completed ? `${days} 天前完成` : `${days} 天前`;
  }
  const dateLabel = new Date(t).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
  return completed ? `${dateLabel}完成` : dateLabel;
}

/** UUID / 长十六进制配置 id：绝不展示到卡片右上角。 */
const OPAQUE_ID_RE =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|[0-9a-f]{24,})$/i;

function looksLikeOpaqueId(value: string | undefined): boolean {
  if (typeof value !== 'string') return false;
  const raw = value.trim();
  return raw.length > 0 && OPAQUE_ID_RE.test(raw);
}

/** 只保留用户可读标签；脏 UUID 直接丢掉。 */
function safeDisplayLabel(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const raw = value.trim();
  if (!raw || looksLikeOpaqueId(raw)) return undefined;
  return raw;
}

/** 任务卡元信息：来源/交付与渠道/模型/时长/相对时间可分组。 */
type WorkItemMetaGroup = 'all' | 'route' | 'runtime';

function workItemMetaParts(
  item: TaskOverviewItem,
  fallbackWhenEmpty = 'LIVE',
  group: WorkItemMetaGroup = 'all',
): string[] {
  const parts: string[] = [];
  const providerLabel = safeDisplayLabel(item.providerLabel);
  const modelLabel = safeDisplayLabel(item.modelLabel);
  const includeRoute = group !== 'runtime';
  const includeRuntime = group !== 'route';
  if (includeRoute && item.deliveryRoute) parts.push(item.deliveryRoute);
  if (includeRoute && item.deliveryHandoffLabel) parts.push(item.deliveryHandoffLabel);
  if (includeRuntime) {
    if (providerLabel) parts.push(providerLabel);
    if (modelLabel) parts.push(modelLabel);
    if (typeof item.durationMs === 'number' && Number.isFinite(item.durationMs) && item.durationMs >= 0) {
      parts.push(formatDuration(item.durationMs));
    }
    // 结果待验收：优先 completedAt，文案为「N 分钟前完成」；其它卡片仍用 lastActiveAt。
    if (item.completedAt) {
      parts.push(formatRelativeTime(item.completedAt, { completed: true }));
    } else if (item.lastActiveAt) {
      parts.push(formatRelativeTime(item.lastActiveAt));
    }
  }
  if (parts.length === 0 && group === 'all') {
    parts.push(fallbackWhenEmpty);
  }
  return parts;
}

/** 任务卡元信息。route = 来源/交付；runtime = 渠道/模型/时长/相对时间。 */
function useLiveDurationMs(item: TaskOverviewItem): number | undefined {
  const isLive = item.actionRight === 'peer_advancing'
    && typeof item.activeSegmentStartedAt === 'string';
  const snapshotRef = useRef({ item, durationMs: item.durationMs, capturedAt: Date.now() });
  if (snapshotRef.current.item !== item) {
    snapshotRef.current = { item, durationMs: item.durationMs, capturedAt: Date.now() };
  }
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!isLive) return undefined;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [isLive, item.taskId]);
  if (!isLive || typeof snapshotRef.current.durationMs !== 'number') return item.durationMs;
  return snapshotRef.current.durationMs + Math.max(0, nowMs - snapshotRef.current.capturedAt);
}

function WorkItemMeta({
  item,
  fallbackWhenEmpty = 'LIVE',
  group = 'all',
}: {
  readonly item: TaskOverviewItem;
  readonly fallbackWhenEmpty?: string;
  readonly group?: WorkItemMetaGroup;
}) {
  const liveDurationMs = useLiveDurationMs(item);
  const displayItem = liveDurationMs === item.durationMs ? item : { ...item, durationMs: liveDurationMs };
  const parts = workItemMetaParts(displayItem, fallbackWhenEmpty, group);
  if (parts.length === 0) return null;
  const providerLabel = safeDisplayLabel(displayItem.providerLabel);
  const modelLabel = safeDisplayLabel(displayItem.modelLabel);
  const className =
    group === 'runtime'
      ? 'task-overview-work-meta task-overview-work-meta--runtime'
      : group === 'route'
        ? 'task-overview-work-meta task-overview-work-meta--route'
        : 'task-overview-work-meta';
  return (
    <div className={className} aria-label="任务元信息">
      {parts.map((part, index) => {
        const isProvider = Boolean(providerLabel && part === providerLabel);
        const isModel = Boolean(modelLabel && part === modelLabel);
        const isDuration =
          typeof displayItem.durationMs === 'number' && formatDuration(displayItem.durationMs) === part;
        return (
          <span key={`${part}-${index}`} className="task-overview-work-meta-part">
            {index > 0 ? (
              <span className="task-overview-work-meta-sep" aria-hidden="true">
                ·
              </span>
            ) : null}
            {isProvider ? (
              <span className="task-overview-work-provider">{part}</span>
            ) : isModel ? (
              <span className="task-overview-work-model">{part}</span>
            ) : isDuration ? (
              <time
                className="task-overview-work-duration"
                dateTime={`PT${Math.floor((displayItem.durationMs ?? 0) / 1000)}S`}
              >
                {part}
              </time>
            ) : (
              <time>{part}</time>
            )}
          </span>
        );
      })}
    </div>
  );
}

function formatTodayCrumb(): string {
  const d = new Date();
  return `今天，${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

function progressPercent(item: TaskOverviewItem): number {
  const p = item.planProgress;
  if (!p || !p.total) return 0;
  return Math.max(0, Math.min(100, Math.round((p.completed / p.total) * 100)));
}

function reasonTitle(item: TaskOverviewItem): string {
  // 投影层尚未单独建模「决策事由」字段，过渡期用 statusLabel 作主因，
  // 副行用 plan 进度 / action 补充。
  if (item.nextAction === 'approve_plan') return '确认计划边界';
  if (item.nextAction === 'confirm_scope') return '确认目标范围';
  if (item.nextAction === 'grant_permission') return '授权执行权限';
  if (item.nextAction === 'answer_question') return '回答阻塞问题';
  if (item.nextAction === 'decide_blocked') return '处理执行阻塞';
  if (item.nextAction === 'review_result') return '验收交付结果';
  return item.statusLabel;
}

function reasonMeta(item: TaskOverviewItem): string {
  if (item.planProgress) {
    return `计划 ${item.planProgress.completed} / ${item.planProgress.total} · ${item.statusLabel}`;
  }
  return item.statusLabel;
}

function planStepStatusLabel(status: string): string {
  switch (status) {
    case 'completed':
      return '已完成';
    case 'running':
      return '进行中';
    case 'failed':
      return '失败';
    case 'cancelled':
      return '已取消';
    case 'waiting_user':
      return '等待你';
    default:
      return '待开始';
  }
}

/** 「正在讨论」首页预览条数：克制，避免盖过行动权三桶。 */
const DISCUSSION_PREVIEW_LIMIT = 6;

/**
 * 板块头部的次级入口。
 *
 * 文案 / 数量徽标 / 箭头拆成独立元素：文案承载语义，徽标承载数字，
 * 箭头用规范 chevron 图标（不再用裸「→」字符与「·」拼接），hover 时轻微右移。
 */
function SectionLink({
  label,
  count,
  countHint,
  onClick,
}: {
  readonly label: string;
  readonly count?: number;
  readonly countHint?: string;
  readonly onClick: () => void;
}) {
  const hasCount = typeof count === 'number' && count > 0;
  return (
    <button
      type="button"
      className="task-overview-section-link"
      onClick={onClick}
      aria-label={hasCount && countHint ? `${label}，${countHint}` : label}
    >
      <span className="task-overview-section-link__label">{label}</span>
      {hasCount ? (
        <span className="task-overview-section-link__count" aria-hidden="true">
          {count}
        </span>
      ) : null}
      <span className="task-overview-section-link__arrow" aria-hidden="true">
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="m9 18 6-6-6-6" />
        </svg>
      </span>
    </button>
  );
}

function advancingStateLabel(item: TaskOverviewItem): string {
  const s = item.statusLabel;
  if (s.includes('验证')) return '正在验证';
  if (s.includes('整理') || s.includes('生成')) return '正在整理';
  if (s.includes('排队')) return '排队中';
  return '正在执行';
}

export function TaskOverviewPage({
  title,
  subtitle,
  filter,
  emptyLabel = '暂无任务',
  hero = false,
  workspacePath = null,
  includeTerminal = false,
  enabled = true,
  onOpenTasks,
  onOpenHistory,
  onNewTask,
  onOpenItem,
  onAcceptResult,
  acceptHandlerRef,
  onCancelItem,
  onOpenTools,
}: TaskOverviewPageProps) {
  const items = useTaskOverview({ enabled, workspacePath, includeTerminal });
  const filtered = items.filter(filter);
  const scopeLabel = scopeDisplayLabel(workspacePath);

  if (hero) {
    return (
      <HeroLayout
        title={title}
        subtitle={subtitle}
        items={filtered}
        allItems={items}
        emptyLabel={emptyLabel}
        scopeLabel={scopeLabel}
        onOpenTasks={onOpenTasks}
        onOpenHistory={onOpenHistory}
        onNewTask={onNewTask}
        onOpenItem={onOpenItem}
        onAcceptResult={onAcceptResult}
        acceptHandlerRef={acceptHandlerRef}
        onCancelItem={onCancelItem}
        onOpenTools={onOpenTools}
      />
    );
  }

  return (
    <ListLayout
      title={title}
      subtitle={subtitle}
      items={filtered}
      emptyLabel={emptyLabel}
      scopeLabel={scopeLabel}
      crumbExtra={includeTerminal ? '已结束的工作' : '未结束的工作'}
    />
  );
}

function TopLine({
  pageTitle,
  crumbExtra,
  scopeLabel,
  onOpenTools,
}: {
  readonly pageTitle: string;
  readonly crumbExtra: string;
  readonly scopeLabel: string;
  readonly onOpenTools?: () => void;
}) {
  const i18n = useMemo(() => createI18n(), []);
  const { localAccessLevel } = useLocalAccessPreference();

  return (
    <div className="task-overview-topline">
      <div className="task-overview-crumb">
        <b>{pageTitle}</b>
        <span>/</span>
        <span>{crumbExtra}</span>
      </div>
      <div className="task-overview-topline-end">
        {onOpenTools ? (
          <ChatHeaderCapabilities
            i18n={i18n}
            localAccessLevel={localAccessLevel}
            onOpenTools={onOpenTools}
          />
        ) : null}
        <div className="task-overview-scope">
          <i className="task-overview-scope-dot" aria-hidden="true" />
          {scopeLabel}
        </div>
      </div>
    </div>
  );
}

type AcceptanceTransition = {
  readonly item: TaskOverviewItem;
  readonly phase: AcceptancePhase;
};

function HeroLayout({
  title: _title,
  subtitle,
  items,
  allItems,
  emptyLabel,
  scopeLabel,
  onOpenTasks,
  onOpenHistory,
  onNewTask,
  onOpenItem,
  onAcceptResult,
  acceptHandlerRef,
  onCancelItem,
  onOpenTools,
}: {
  readonly title: string;
  readonly subtitle?: string;
  readonly items: readonly TaskOverviewItem[];
  /** 未按首页 filter 剔除的全量投影，供压缩树补同线上下文。 */
  readonly allItems?: readonly TaskOverviewItem[];
  readonly emptyLabel: string;
  readonly scopeLabel: string;
  readonly onOpenTasks?: () => void;
  readonly onOpenHistory?: () => void;
  readonly onNewTask?: () => void;
  readonly onOpenItem?: OpenTaskOverviewItem;
  readonly onAcceptResult?: (item: TaskOverviewItem) => void | Promise<void>;
  readonly acceptHandlerRef?: MutableRefObject<((item: TaskOverviewItem) => void | Promise<void>) | null>;
  readonly onCancelItem?: (item: TaskOverviewItem) => void | Promise<void>;
  readonly onOpenTools?: () => void;
}) {
  const unread = items.filter((i) => i.source === 'conversation' && i.isUnread === true);
  const visibleUnread = unread.slice(0, DISCUSSION_PREVIEW_LIMIT);
  const hiddenUnreadCount = Math.max(0, unread.length - visibleUnread.length);
  const needsYou = items.filter((i) => i.source !== 'conversation' && i.actionRight === 'needs_you');
  const paused = items.filter(
    (i) => i.source !== 'conversation' && i.actionRight === 'paused',
  );
  const advancing = items.filter((i) => i.source !== 'conversation' && i.actionRight === 'peer_advancing');
  const resultReady: TaskOverviewItem[] = [];
  const [acceptanceTransitions, setAcceptanceTransitions] = useState<
    Record<string, AcceptanceTransition>
  >({});
  const [acceptanceOrderSnapshot, setAcceptanceOrderSnapshot] = useState<readonly string[]>([]);
  const [isHeaderCompact, setIsHeaderCompact] = useState(false);
  const [backgroundBarHost, setBackgroundBarHost] = useState<HTMLElement | null>(null);
  const headerSentinelRef = useRef<HTMLDivElement>(null);
  const transitionTimers = useRef<Set<number>>(new Set());

  useEffect(() => {
    const sentinel = headerSentinelRef.current;
    const scrollContainer = sentinel?.closest<HTMLElement>('.task-overview-scroll-region');
    if (!sentinel || !scrollContainer) return;

    const observer = new IntersectionObserver(
      ([entry]) => setIsHeaderCompact(!entry.isIntersecting),
      { root: scrollContainer, threshold: 0 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const sentinel = headerSentinelRef.current;
    setBackgroundBarHost(sentinel?.closest<HTMLElement>('.task-overview-page-layer') ?? null);
  }, []);

  useEffect(
    () => () => {
      for (const timer of transitionTimers.current) window.clearTimeout(timer);
      transitionTimers.current.clear();
    },
    [],
  );

  useEffect(() => {
    if (Object.keys(acceptanceTransitions).length === 0 && acceptanceOrderSnapshot.length > 0) {
      setAcceptanceOrderSnapshot([]);
    }
  }, [acceptanceOrderSnapshot.length, acceptanceTransitions]);

  const scheduleTransition = useCallback((callback: () => void, delayMs: number) => {
    const timer = window.setTimeout(() => {
      transitionTimers.current.delete(timer);
      callback();
    }, delayMs);
    transitionTimers.current.add(timer);
  }, []);

  const handleAccept = useCallback(async (item: TaskOverviewItem) => {
    if (!onAcceptResult || item.source !== 'goal_plan' || !item.taskId) return;
    if (acceptanceTransitions[item.taskId]) return;

    // Freeze the complete visual order before awaited IPC refresh removes the accepted item.
    // A single old index is insufficient because every following card shifts forward after removal.
    if (Object.keys(acceptanceTransitions).length === 0) {
      setAcceptanceOrderSnapshot(resultReady.map((candidate) => candidate.taskId));
    }
    setAcceptanceTransitions((prev) => ({
      ...prev,
      [item.taskId]: { item, phase: 'submitting' },
    }));

    try {
      await onAcceptResult(item);
      // 合回在后台进行。卡片先停在 submitting，等 delivered 再庆祝退场。
    } catch {
      setAcceptanceTransitions((prev) => {
        if (!(item.taskId in prev)) return prev;
        const next = { ...prev };
        delete next[item.taskId];
        return next;
      });
    }
  }, [acceptanceTransitions, onAcceptResult, resultReady]);

  useEffect(() => {
    const submittingIds = Object.entries(acceptanceTransitions)
      .filter(([, transition]) => transition.phase === 'submitting')
      .map(([taskId]) => taskId);
    if (submittingIds.length === 0) return;

    for (const taskId of submittingIds) {
      const live = resultReady.find((item) => item.taskId === taskId);
      if (live?.deliveryHandoffStatus === 'stopped') {
        setAcceptanceTransitions((prev) => {
          if (!(taskId in prev)) return prev;
          const next = { ...prev };
          delete next[taskId];
          return next;
        });
        continue;
      }
      const delivered = live?.deliveryHandoffStatus === 'delivered' || !live;
      if (!delivered) continue;
      setAcceptanceTransitions((prev) => {
        const current = prev[taskId];
        if (!current || current.phase !== 'submitting') return prev;
        return {
          ...prev,
          [taskId]: { ...current, phase: 'celebrating' },
        };
      });
      scheduleTransition(() => {
        setAcceptanceTransitions((prev) => {
          const current = prev[taskId];
          if (!current) return prev;
          return {
            ...prev,
            [taskId]: { ...current, phase: 'exiting' },
          };
        });
        scheduleTransition(() => {
          setAcceptanceTransitions((prev) => {
            if (!(taskId in prev)) return prev;
            const next = { ...prev };
            delete next[taskId];
            return next;
          });
        }, ACCEPTANCE_EXIT_MS);
      }, ACCEPTANCE_CELEBRATION_MS);
    }
  }, [acceptanceTransitions, resultReady, scheduleTransition]);

  useEffect(() => {
    if (!acceptHandlerRef) return;
    acceptHandlerRef.current = handleAccept;
    return () => {
      if (acceptHandlerRef.current === handleAccept) {
        acceptHandlerRef.current = null;
      }
    };
  }, [acceptHandlerRef, handleAccept]);

  const needsYouCards = groupInboxByConversation(needsYou);
  const pausedCards = groupInboxByConversation(paused);
  const hasInbox = needsYouCards.length + pausedCards.length > 0;

  return (
    <div className="task-overview-page task-overview-page--home">
      <div ref={headerSentinelRef} className="task-overview-header-sentinel" aria-hidden="true" />
      <div className="task-overview-compact-anchor">
        <header
          className={`task-overview-compact-header${isHeaderCompact ? ' is-visible' : ''}`}
          data-header-state={isHeaderCompact ? 'compact' : 'expanded'}
          aria-hidden={!isHeaderCompact}
        >
          <div className="task-overview-compact-context">
            <strong>工作台</strong>
            <span className="task-overview-scope">
              <i className="task-overview-scope-dot" />
              {scopeLabel}
            </span>
          </div>
          <div className="task-overview-compact-stats" aria-label="工作台状态">
            <span><b>{needsYouCards.length}</b> 需要你</span>
            <span><b>{advancing.length}</b> 正在推进</span>
            <span><b>{unread.length}</b> 未读</span>
          </div>
        </header>
      </div>

      <TopLine
        pageTitle="工作台"
        crumbExtra={formatTodayCrumb()}
        scopeLabel={scopeLabel}
        onOpenTools={onOpenTools}
      />

      <header className="task-overview-hero">
        <div className="task-overview-hero-copy">
          <h1>现在轮到你做什么</h1>
          <p>
            {subtitle ?? '需要你时才来找你。其余 Peer 自己推进。'}
          </p>
        </div>
        <div className="task-overview-hero-stats">
          <div className="task-overview-stat">
            <b>{needsYouCards.length}</b>
            <span>需要你</span>
          </div>
          <div className="task-overview-stat">
            <b>{advancing.length}</b>
            <span>正在推进</span>
          </div>
          <div className="task-overview-stat">
            <b>{unread.length}</b>
            <span>未读</span>
          </div>
        </div>
      </header>

      {!hasInbox && unread.length === 0 && advancing.length === 0 ? (
        <div className="task-overview-empty">
          <p>{emptyLabel}</p>
          {onNewTask ? (
            <button
              type="button"
              className="task-overview-btn task-overview-btn--primary task-overview-empty-action"
              onClick={onNewTask}
            >
              发起新任务
            </button>
          ) : null}
        </div>
      ) : (
        <>
          {needsYouCards.length > 0 ? (
            <section className="task-overview-section">
              <div className="task-overview-section-head">
                <div className="task-overview-section-title">
                  <h2>需要你</h2>
                  <small>{needsYouCards.length}</small>
                </div>
                <span className="task-overview-section-meta">遇到选项、决策或权限</span>
              </div>
              <div
                className={`task-overview-handoff-list${needsYouCards.length === 1 ? ' task-overview-handoff-list--single' : ''}`}
              >
                {needsYouCards.map((card) => (
                  <HandoffRow key={card.key} item={card.latestItem} onOpenItem={onOpenItem} />
                ))}
              </div>
            </section>
          ) : null}

          {pausedCards.length > 0 ? (
            <section className="task-overview-section">
              <div className="task-overview-section-head">
                <div className="task-overview-section-title">
                  <h2 title="执行异常">执行异常</h2>
                  <small>{pausedCards.length}</small>
                </div>
                <span className="task-overview-section-hint">中断原因与恢复入口已保留</span>
              </div>
              <div className="task-overview-work-stream">
                {pausedCards.map((card) => (
                  <WorkItem
                    key={card.key}
                    item={card.latestItem}
                    onOpenItem={onOpenItem}
                    actionSlot={
                      card.latestItem.nextAction === 'resume' && onOpenItem ? (
                        <button
                          type="button"
                          className="task-overview-text-action"
                          onClick={(event) => {
                            event.stopPropagation();
                            onOpenItem(card.latestItem);
                          }}
                        >
                          继续执行
                        </button>
                      ) : undefined
                    }
                  />
                ))}
              </div>
            </section>
          ) : null}

          {advancing.length > 0 ? (
            <section className="task-overview-section">
              <div className="task-overview-section-head">
                <div className="task-overview-section-title">
                  <h2>正在推进</h2>
                  <small>{advancing.length}</small>
                </div>
                <span className="task-overview-section-hint">Peer 正在做，你不用插手</span>
              </div>
              <div className="task-overview-work-stream">
                {advancing.map((item) => (
                  <WorkItem
                    key={item.taskId}
                    item={item}
                    onOpenItem={onOpenItem}
                    onCancelItem={onCancelItem}
                  />
                ))}
              </div>
            </section>
          ) : null}

          {unread.length > 0 ? (
            <section className="task-overview-section task-overview-section--discuss">
              <div className="task-overview-section-head">
                <div className="task-overview-section-title">
                  <h2>未读</h2>
                  <small>{unread.length}</small>
                </div>
                {onOpenTasks ? (
                  <SectionLink
                    label="查看全部"
                    count={hiddenUnreadCount}
                    countHint={`还有 ${hiddenUnreadCount} 条`}
                    onClick={onOpenTasks}
                  />
                ) : (
                  <span className="task-overview-section-meta">打开看一眼即可</span>
                )}
              </div>
              <div className="task-overview-discussion-grid">
                {visibleUnread.map((item) => (
                  <DiscussionCard key={item.taskId} item={item} onOpenItem={onOpenItem} />
                ))}
              </div>
            </section>
          ) : null}
        </>
      )}

{backgroundBarHost && advancing.length > 0
        ? createPortal(
            <aside className="task-overview-background-bar" aria-label="后台进行中">
              <button
                type="button"
                className="task-overview-background-bar__cluster"
                onClick={onOpenTasks}
                disabled={!onOpenTasks}
              >
                <span className="task-overview-background-bar__pulse" aria-hidden="true" />
                <span className="task-overview-background-bar__copy">
                  <b>{advancing.length}</b>
                  正在推进
                </span>
                {advancing[0]?.planProgress && advancing[0].planProgress.total > 0 ? (
                  <span className="task-overview-background-bar__meter" aria-hidden="true">
                    <i
                      style={{
                        width: `${Math.max(
                          6,
                          Math.min(
                            100,
                            Math.round(
                              (advancing[0].planProgress.completed / advancing[0].planProgress.total) * 100,
                            ),
                          ),
                        )}%`,
                      }}
                    />
                  </span>
                ) : null}
                <span className="task-overview-background-bar__hint">
                  {advancing[0]?.title ?? '查看任务'}
                </span>
              </button>
            </aside>,
            backgroundBarHost,
          )
        : null}
    </div>
  );
}


function ListLayout({
  title,
  subtitle,
  items,
  emptyLabel,
  scopeLabel,
  crumbExtra,
}: {
  readonly title: string;
  readonly subtitle?: string;
  readonly items: readonly TaskOverviewItem[];
  readonly emptyLabel: string;
  readonly scopeLabel: string;
  readonly crumbExtra: string;
}) {
  return (
    <div className="task-overview-page">
      <TopLine pageTitle={title} crumbExtra={crumbExtra} scopeLabel={scopeLabel} />
      <header className="task-overview-header">
        <h1>{title}</h1>
        {subtitle ? <p className="task-overview-subtitle">{subtitle}</p> : null}
      </header>

      {items.length === 0 ? (
        <div className="task-overview-empty">
          <p>{emptyLabel}</p>
        </div>
      ) : (
        <div className="task-overview-list">
          {items.map((item) => (
            <WorkItem key={item.taskId} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}

/** 四列交接行：任务 / 行动权 / 决策事由 / 主操作 */
const HandoffRow = memo(function HandoffRow({
  item,
  onOpenItem,
}: {
  readonly item: TaskOverviewItem;
  readonly onOpenItem?: (item: TaskOverviewItem) => void;
}) {
  const primary =
    item.nextAction === 'approve_plan' ||
    item.nextAction === 'decide_blocked' ||
    item.nextAction === 'confirm_scope' ||
    item.nextAction === 'review_result';
  return (
    <article className="task-overview-handoff-row">
      <div className="task-overview-task-copy">
        <strong>{item.title}</strong>
        <div className="task-overview-handoff-reason">{reasonTitle(item)}</div>
        <div className="task-overview-handoff-context">
          <span>{item.deliveryRoute ?? item.workspaceLabel ?? 'workspace'}</span>
          <span aria-hidden="true">·</span>
          <span>{formatRelativeTime(item.lastActiveAt)}</span>
          {item.planProgress ? (
            <>
              <span aria-hidden="true">·</span>
              <span>
                计划 {item.planProgress.completed} / {item.planProgress.total}
              </span>
            </>
          ) : null}
        </div>
      </div>
      <button
        type="button"
        className={primary ? 'task-overview-btn task-overview-btn--primary' : 'task-overview-btn task-overview-btn--secondary'}
        onClick={() => onOpenItem?.(item)}
      >
        <ActionLabel label={item.actionLabel} />
      </button>
    </article>
  );
});

/** 无计划讨论卡：只表达讨论上下文，不复用执行状态或进度。 */
const DiscussionCard = memo(function DiscussionCard({
  item,
  onOpenItem,
}: {
  readonly item: TaskOverviewItem;
  readonly onOpenItem?: (item: TaskOverviewItem) => void;
}) {
  const statusLabel = item.statusLabel || '有未读';
  const statusTone = statusLabel === '已读' ? 'is-read' : 'is-unread';

  return (
    <article
      className={`task-overview-discussion-card${onOpenItem ? ' is-clickable' : ''}`}
      onClick={() => onOpenItem?.(item)}
    >
      <div className="task-overview-discussion-card__meta">
        <span className={`task-overview-discussion-card__status ${statusTone}`}>
          <i aria-hidden="true" />
          {statusLabel}
        </span>
        <time>{formatRelativeTime(item.lastActiveAt)}</time>
      </div>
      <h3>{item.title}</h3>
      <div className="task-overview-discussion-card__footer">
        <span>{item.deliveryRoute ?? item.workspaceLabel ?? '当前 Workspace'}</span>
        <strong><ActionLabel label={item.actionLabel || '打开'} /></strong>
      </div>
    </article>
  );
});

/** 推进中工作卡：状态 + 标题 + 进度条 + 取消 */
const WorkItem = memo(function WorkItem({
  item,
  onOpenItem,
  onCancelItem,
  actionSlot,
}: {
  readonly item: TaskOverviewItem;
  readonly onOpenItem?: (item: TaskOverviewItem) => void;
  readonly onCancelItem?: (item: TaskOverviewItem) => void | Promise<void>;
  readonly actionSlot?: ReactNode;
}) {
  const pct = progressPercent(item);
  const canCancel = item.source === 'goal_plan' && typeof onCancelItem === 'function';
  return (
    <article
      className={`task-overview-work-item task-overview-work-item--${item.actionRight}${onOpenItem ? ' is-clickable' : ''}`}
      onClick={() => onOpenItem?.(item)}
      role={onOpenItem ? 'button' : undefined}
      tabIndex={onOpenItem ? 0 : undefined}
      onKeyDown={(event) => {
        if (!onOpenItem) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpenItem(item);
        }
      }}
    >
      <div className="task-overview-work-top">
        <span className="task-overview-work-state">
          {item.actionRight !== 'paused' && item.source !== 'conversation' ? (
            <i className="task-overview-spinner" aria-hidden="true" />
          ) : null}
          {item.actionRight === 'paused' ? item.statusLabel : advancingStateLabel(item)}
        </span>
        <WorkItemMeta item={item} group="route" />
      </div>
      <h3>{item.title}</h3>
      {item.currentGoalTitle ? (
        <p className="task-overview-current-goal">当前目标 · {item.currentGoalTitle}</p>
      ) : null}
      <p>{item.issueDetail ?? (item.source === 'conversation' ? '继续讨论，或在明确实施时创建 GoalPlan' : reasonMeta(item))}</p>
      {item.planSteps && item.planSteps.length > 0 ? (
        <ol className="task-overview-plan-steps" aria-label="计划步骤">
          {item.planSteps.map((step) => (
            <li
              key={step.taskId}
              className={`task-overview-plan-step is-${step.status}${step.current ? ' is-current' : ''}`}
            >
              <span className="task-overview-plan-step-marker" aria-hidden="true" />
              <span className="task-overview-plan-step-title">{step.title}</span>
              <span className="task-overview-plan-step-status">
                {step.current && step.status !== 'completed' ? '当前' : planStepStatusLabel(step.status)}
              </span>
            </li>
          ))}
        </ol>
      ) : null}
      {item.planProgress ? (
        <div className="task-overview-progress" aria-hidden="true">
          <i style={{ width: `${pct}%` }} />
        </div>
      ) : null}
      {actionSlot || canCancel || workItemMetaParts(item, 'LIVE', 'runtime').length > 0 ? (
        <div className="result-card-actions work-item-actions">
          <WorkItemMeta item={item} group="runtime" />
          <div className="work-item-actions__buttons">
          {actionSlot}
          {canCancel ? (
            <button
              type="button"
              className="task-overview-btn task-overview-btn--secondary"
              onClick={(event) => {
                event.stopPropagation();
                void onCancelItem?.(item);
              }}
            >
              取消
            </button>
          ) : null}
          </div>
        </div>
      ) : null}
    </article>
  );
});


const ARTIFACT_PREVIEW_CHROME_STYLE = {
  background: 'transparent',
} as const;

function ArtifactHoverPreview({ artifact }: { readonly artifact: TaskOverviewArtifact }) {
  const preview = artifact.preview;
  if (!preview) return null;
  if (preview.kind === 'image') {
    return (
      <div className="task-artifact-preview task-artifact-preview--image" role="tooltip" style={ARTIFACT_PREVIEW_CHROME_STYLE}>
        <img
          src={preview.dataUrl}
          width={preview.width}
          height={preview.height}
          alt={`${artifact.label}缩略图`}
        />
      </div>
    );
  }
  return (
    <div className="task-artifact-preview task-artifact-preview--code" role="tooltip" style={ARTIFACT_PREVIEW_CHROME_STYLE}>
      <div className="task-artifact-preview-header">
        <strong>{artifact.label}</strong>
        <span className="task-artifact-preview-stats">
          <span className="task-artifact-preview-additions">+{preview.additions}</span>
          <span className="task-artifact-preview-deletions">−{preview.deletions}</span>
        </span>
      </div>
      <pre className="task-artifact-diff">
        {buildDiffLines(preview.diffLines.join('\n')).filter((line) => line.kind !== 'meta').map((line, index) => (
          <code
            className={
              line.kind === 'add'
                ? 'task-artifact-diff-line task-artifact-diff-line--added'
                : line.kind === 'del'
                  ? 'task-artifact-diff-line task-artifact-diff-line--deleted'
                  : line.kind === 'hunk' || line.kind === 'meta'
                    ? 'task-artifact-diff-line task-artifact-diff-line--meta'
                    : 'task-artifact-diff-line'
            }
            key={`${index}:${line.oldNo ?? ''}:${line.newNo ?? ''}:${line.text}`}
          >
            <span className="task-artifact-diff-gutter task-artifact-diff-gutter--old" aria-hidden="true">
              {line.oldNo ?? ''}
            </span>
            <span className="task-artifact-diff-gutter task-artifact-diff-gutter--new" aria-hidden="true">
              {line.newNo ?? ''}
            </span>
            <span className="task-artifact-diff-text">{line.text === '' ? '\u00a0' : line.text}</span>
          </code>
        ))}
      </pre>
    </div>
  );
}

interface ActiveArtifactPreview {
  readonly artifact: TaskOverviewArtifact;
  readonly anchor: HTMLElement;
}

function ArtifactPreviewPortal({ active }: { readonly active: ActiveArtifactPreview }) {
  const previewRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number; placement: 'above' | 'below' } | null>(null);

  useLayoutEffect(() => {
    const updatePosition = () => {
      const previewElement = previewRef.current;
      if (!previewElement || !active.anchor.isConnected) return;
      const triggerRect = active.anchor.getBoundingClientRect();
      const previewRect = previewElement.getBoundingClientRect();
      setPosition(positionTaskArtifactPreview(
        triggerRect,
        { width: previewRect.width, height: previewRect.height },
        { width: window.innerWidth, height: window.innerHeight },
      ));
    };
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [active]);

  return createPortal(
    <div
      ref={previewRef}
      id={`artifact-preview-${encodeURIComponent(active.artifact.ref)}`}
      className={`task-artifact-preview-portal task-artifact-preview-portal--${active.artifact.preview?.kind ?? 'code'} is-${position?.placement ?? 'below'}`}
      style={{
        position: 'fixed',
        zIndex: 2147483000,
        left: position?.left ?? 0,
        top: position?.top ?? 0,
        maxWidth: availablePreviewSize({ width: window.innerWidth, height: window.innerHeight }).width,
        visibility: position ? 'visible' : 'hidden',
      }}
    >
      <ArtifactHoverPreview artifact={active.artifact} />
    </div>,
    document.body,
  );
}

function ArtifactList({ item }: { readonly item: TaskOverviewItem }) {
  const [activePreview, setActivePreview] = useState<ActiveArtifactPreview | null>(null);
  const projection = projectTaskOverviewArtifacts(item);
  if (projection.total === 0) return null;
  return (
    <>
    <details className="task-artifacts">
      <summary className="task-artifacts-summary" onClick={(event) => event.stopPropagation()}>
        <span>主要产物</span>
        <span className="task-artifacts-count">{projection.summary}</span>
        <span className="task-artifacts-chevron" aria-hidden="true" />
      </summary>
      <div className="task-artifacts-content" aria-label="主要产物">
        {projection.groups.map((group) => (
          <section className="task-artifacts-group" key={group.kind}>
            <div className="task-artifacts-group-title">
              <span>{group.label}</span>
              <span>{group.total}</span>
            </div>
            <ul className="task-artifacts-list">
              {group.artifacts.map((artifact) => (
                <li
                  className="task-artifact-shell"
                  key={`${artifact.kind}:${artifact.ref}`}
                  onPointerEnter={(event) => {
                    if (artifact.preview) setActivePreview({ artifact, anchor: event.currentTarget });
                  }}
                  onPointerLeave={() => setActivePreview(null)}
                  onFocus={(event) => {
                    if (artifact.preview) setActivePreview({ artifact, anchor: event.currentTarget });
                  }}
                  onBlur={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget)) setActivePreview(null);
                  }}
                >
                  <button
                    type="button"
                    className={`task-artifact task-artifact--${artifact.kind}`}
                    aria-describedby={activePreview?.artifact.ref === artifact.ref
                      ? `artifact-preview-${encodeURIComponent(artifact.ref)}`
                      : undefined}
                    onClick={(event) => {
                      event.stopPropagation();
                      void clientApi.openPath(artifact.openPath!);
                    }}
                  >
                    <span className="task-artifact-copy">
                      <span className="task-artifact-name" title={artifact.label}>{artifact.label}</span>
                    </span>
                    {artifact.preview?.kind === 'code' ? (
                      <span
                        className="task-artifact-stat"
                        aria-label={
                          artifact.preview.deletions > 0
                            ? `新增 ${artifact.preview.additions} 行，删除 ${artifact.preview.deletions} 行`
                            : `新增 ${artifact.preview.additions} 行`
                        }
                      >
                        <span className="task-artifact-stat-add">+{artifact.preview.additions}</span>
                        {artifact.preview.deletions > 0 ? (
                          <span className="task-artifact-stat-del">−{artifact.preview.deletions}</span>
                        ) : null}
                      </span>
                    ) : null}
                    <span className="task-artifact-action">{artifact.actionLabel}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
        {projection.hiddenTotal > 0 ? (
          <p className="task-artifacts-limit-note">仅显示前 {projection.visibleTotal} 项主要产物</p>
        ) : null}
      </div>
    </details>
    {activePreview ? <ArtifactPreviewPortal active={activePreview} /> : null}
    </>
  );
}

/** 结果待验收卡片 —— 与推进中同款双列卡片：顶栏状态 + 标题 + 摘要 + 操作 */
function ResultCard({
  item,
  phase,
  onOpenItem,
  threadNodes,
  pendingCount,
  acceptTogether,
}: {
  readonly item: TaskOverviewItem;
  readonly phase: AcceptancePhase | null;
  readonly onOpenItem?: OpenTaskOverviewItem;
  readonly threadNodes?: readonly ThreadListNode[];
  readonly pendingCount?: number;
  readonly acceptTogether?: readonly TaskOverviewItem[];
}) {
  const cardRef = useRef<HTMLElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  useShatterExitCollapse(phase, hostRef);
  const summary = item.planProgress
    ? `${item.planProgress.total} 项标准通过 · ${item.planProgress.completed} 项完成 · 无已知风险`
    : 'Peer 已完成并带回 Evidence · 无已知风险';
  const pct = progressPercent(item);
  const celebrating = phase === 'celebrating' || phase === 'exiting';
  const shattering = celebrating;
  return (
    <div
      ref={hostRef}
      className={`particle-shatter-host${phase === 'exiting' ? ' is-exiting' : ''}`}
    >
    <article
      ref={cardRef}
      className={`task-overview-work-item task-overview-work-item--result_ready result-card particle-shatter-source${threadNodes && threadNodes.length > 0 ? ' goal-thread-card' : ''}${phase === 'submitting' ? ' result-card--submitting' : ''}${shattering ? ' is-shattering' : ''}`}
    >
      <div className="task-overview-work-top">
        <span className="task-overview-work-state result-card-state">
          <i className="result-card-seal" aria-hidden="true">
            ✓
          </i>
          {celebrating
            ? '验收完成，任务已圆满结束'
            : phase === 'submitting' || item.deliveryHandoffStatus === 'delivering'
              ? (item.deliveryHandoffLabel || '正在合进源头')
              : item.deliveryHandoffStatus === 'stopped'
                ? (item.deliveryHandoffLabel || '合不进源头')
                : '等待验收'}
        </span>
        {threadNodes && threadNodes.length > 0 ? (
          <span className="goal-thread-route">
            目标线 · {threadNodes.length} 轮
            {pendingCount && pendingCount > 0 ? ` · ${pendingCount} 项待签` : ''}
          </span>
        ) : (
          <WorkItemMeta item={item} group="route" fallbackWhenEmpty="READY" />
        )}
      </div>
      <h3>{item.title}</h3>
      <p>{summary}</p>
      {item.planProgress ? (
        <div className="task-overview-progress" aria-hidden="true">
          <i style={{ width: `${pct}%` }} />
        </div>
      ) : null}
      {threadNodes && threadNodes.length > 0 ? (
        <ThreadList nodes={threadNodes} currentId={item.taskId} onOpenItem={onOpenItem} />
      ) : null}
      <ArtifactList item={item} />
      <div className="result-card-actions work-item-actions">
        <WorkItemMeta item={item} group="runtime" fallbackWhenEmpty="READY" />
        <div className="work-item-actions__buttons">
        {phase === 'submitting' ? (
          <button type="button" className="task-overview-btn task-overview-btn--primary result-card-accept" disabled>
            <span className="result-card-spinner" aria-hidden="true" />
            正在合进源头…
          </button>
        ) : celebrating ? (
          <button type="button" className="task-overview-btn task-overview-btn--primary result-card-accept" disabled>
            已归档 ✓
          </button>
        ) : (
          <button
            type="button"
            className="task-overview-btn task-overview-btn--primary"
            onClick={() => onOpenItem?.(item, acceptTogether?.length ? { acceptTogether } : undefined)}
          >
            查看进度
          </button>
        )}
        </div>
      </div>
    </article>
      <ParticleShatterOverlay active={shattering} targetRef={cardRef} />
    </div>
  );
}

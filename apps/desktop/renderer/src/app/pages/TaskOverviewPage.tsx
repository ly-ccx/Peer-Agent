import type { TaskOverviewItem } from '@peer-agent/protocol';
import { useEffect, useRef, useState } from 'react';
import { formatDuration } from '../../chat/state/format';
import {
  ACCEPTANCE_CELEBRATION_MS,
  ACCEPTANCE_EXIT_MS,
  mergeAcceptanceTransitionItems,
  type AcceptancePhase,
} from '../state/acceptanceTransition';
import { ParticleShatterOverlay } from '../fx/ParticleShatterOverlay';
import { useTaskOverview } from '../hooks/useTaskOverview';

/**
 * TaskOverview 页面 —— 对齐 peer-2-0 高保真原型工作台结构。
 *
 * 工作台：topline（面包屑 + 范围标签）+ hero（说明 + 统计）
 * + 需要你处理（四列交接卡）+ Peer 正在推进（双列 + 进度条）
 * + 结果待验收。
 *
 * 任务/历史页：统一列表（也可由 Drawer 承载）。
 * 行动权分桶只消费 TaskOverviewItem.actionRight，前端不解析状态机。
 *
 * 结果待验收：卡片叠放展示全部未验收 completed（不限条数）；
 * 主按钮「确认验收」一键落库，次按钮「查看结果」可选进会话。
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
  readonly onOpenTasks?: () => void;
  readonly onOpenHistory?: () => void;
  /** 空态「发起新任务」：跳到新建任务页。 */
  readonly onNewTask?: () => void;
  /** 打开对应会话（决策 / 查看结果）。 */
  readonly onOpenItem?: (item: TaskOverviewItem) => void;
  /** 工作台一键确认验收（仅 goal_plan）。 */
  readonly onAcceptResult?: (item: TaskOverviewItem) => void | Promise<void>;
  /** 取消正在推进的 GoalPlan（仅 goal_plan）。 */
  readonly onCancelItem?: (item: TaskOverviewItem) => void | Promise<void>;
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

/** 相对时间；completed 模式用于结果待验收卡片「何时完成」。 */
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

/** 卡片右上角：提供商 · 模型 · 时长 · 相对时间（完成时间优先于最近活跃）。 */
function workItemMetaParts(item: TaskOverviewItem, fallbackWhenEmpty = 'LIVE'): string[] {
  const parts: string[] = [];
  const providerLabel = safeDisplayLabel(item.providerLabel);
  const modelLabel = safeDisplayLabel(item.modelLabel);
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
  } else if (parts.length === 0) {
    parts.push(fallbackWhenEmpty);
  }
  return parts;
}

/** 推进中 / 等待验收卡片共用的右上角元信息（提供商 · 模型 · 时长 · 相对时间）。 */
function WorkItemMeta({
  item,
  fallbackWhenEmpty = 'LIVE',
}: {
  readonly item: TaskOverviewItem;
  readonly fallbackWhenEmpty?: string;
}) {
  const providerLabel = safeDisplayLabel(item.providerLabel);
  const modelLabel = safeDisplayLabel(item.modelLabel);
  return (
    <div className="task-overview-work-meta" aria-label="任务元信息">
      {workItemMetaParts(item, fallbackWhenEmpty).map((part, index) => {
        const isProvider = Boolean(providerLabel && part === providerLabel);
        const isModel = Boolean(modelLabel && part === modelLabel);
        const isDuration =
          typeof item.durationMs === 'number' && formatDuration(item.durationMs) === part;
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
                dateTime={`PT${Math.floor((item.durationMs ?? 0) / 1000)}S`}
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

function ownerLabel(item: TaskOverviewItem): string {
  if (item.actionRight === 'needs_you') {
    if (item.needsYouReason === 'plan_approval') return '行动权在你';
    if (item.needsYouReason === 'user_input') return '等待确认';
    return '等待决策';
  }
  return item.statusLabel;
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
    return `GoalPlan ${item.planProgress.completed} / ${item.planProgress.total} · ${item.statusLabel}`;
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
const DISCUSSION_PREVIEW_LIMIT = 4;

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
  onOpenTasks,
  onOpenHistory,
  onNewTask,
  onOpenItem,
  onAcceptResult,
  onCancelItem,
}: TaskOverviewPageProps) {
  const items = useTaskOverview({ workspacePath, includeTerminal });
  const filtered = items.filter(filter);
  const scopeLabel = scopeDisplayLabel(workspacePath);

  if (hero) {
    return (
      <HeroLayout
        title={title}
        subtitle={subtitle}
        items={filtered}
        emptyLabel={emptyLabel}
        scopeLabel={scopeLabel}
        onOpenTasks={onOpenTasks}
        onOpenHistory={onOpenHistory}
        onNewTask={onNewTask}
        onOpenItem={onOpenItem}
        onAcceptResult={onAcceptResult}
        onCancelItem={onCancelItem}
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
}: {
  readonly pageTitle: string;
  readonly crumbExtra: string;
  readonly scopeLabel: string;
}) {
  return (
    <div className="task-overview-topline">
      <div className="task-overview-crumb">
        <b>{pageTitle}</b>
        <span>/</span>
        <span>{crumbExtra}</span>
      </div>
      <div className="task-overview-scope">
        <i className="task-overview-scope-dot" aria-hidden="true" />
        {scopeLabel}
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
  emptyLabel,
  scopeLabel,
  onOpenTasks,
  onOpenHistory,
  onNewTask,
  onOpenItem,
  onAcceptResult,
  onCancelItem,
}: {
  readonly title: string;
  readonly subtitle?: string;
  readonly items: readonly TaskOverviewItem[];
  readonly emptyLabel: string;
  readonly scopeLabel: string;
  readonly onOpenTasks?: () => void;
  readonly onOpenHistory?: () => void;
  readonly onNewTask?: () => void;
  readonly onOpenItem?: (item: TaskOverviewItem) => void;
  readonly onAcceptResult?: (item: TaskOverviewItem) => void | Promise<void>;
  readonly onCancelItem?: (item: TaskOverviewItem) => void | Promise<void>;
}) {
  const discussions = items.filter((i) => i.source === 'conversation');
  const visibleDiscussions = discussions.slice(0, DISCUSSION_PREVIEW_LIMIT);
  const hiddenDiscussionCount = Math.max(0, discussions.length - visibleDiscussions.length);
  const needsYou = items.filter((i) => i.source !== 'conversation' && i.actionRight === 'needs_you');
  const advancing = items.filter((i) => i.source !== 'conversation' && i.actionRight === 'peer_advancing');
  const resultReady = items.filter((i) => i.source !== 'conversation' && i.actionRight === 'result_ready');
  const [acceptanceTransitions, setAcceptanceTransitions] = useState<
    Record<string, AcceptanceTransition>
  >({});
  const [acceptanceOrderSnapshot, setAcceptanceOrderSnapshot] = useState<readonly string[]>([]);
  const transitionTimers = useRef<Set<number>>(new Set());

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

  const scheduleTransition = (callback: () => void, delayMs: number) => {
    const timer = window.setTimeout(() => {
      transitionTimers.current.delete(timer);
      callback();
    }, delayMs);
    transitionTimers.current.add(timer);
  };

  const handleAccept = async (item: TaskOverviewItem) => {
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
      setAcceptanceTransitions((prev) => {
        const current = prev[item.taskId];
        if (!current) return prev;
        return {
          ...prev,
          [item.taskId]: { ...current, phase: 'celebrating' },
        };
      });
      scheduleTransition(() => {
        setAcceptanceTransitions((prev) => {
          const current = prev[item.taskId];
          if (!current) return prev;
          return {
            ...prev,
            [item.taskId]: { ...current, phase: 'exiting' },
          };
        });
        scheduleTransition(() => {
          setAcceptanceTransitions((prev) => {
            if (!(item.taskId in prev)) return prev;
            const next = { ...prev };
            delete next[item.taskId];
            return next;
          });
        }, ACCEPTANCE_EXIT_MS);
      }, ACCEPTANCE_CELEBRATION_MS);
    } catch {
      setAcceptanceTransitions((prev) => {
        if (!(item.taskId in prev)) return prev;
        const next = { ...prev };
        delete next[item.taskId];
        return next;
      });
    }
  };

  const displayedResults = mergeAcceptanceTransitionItems({
    currentItems: resultReady,
    transitions: Object.values(acceptanceTransitions),
    orderSnapshot: acceptanceOrderSnapshot,
  });

  const hasAny = discussions.length + needsYou.length + advancing.length + resultReady.length > 0;

  return (
    <div className="task-overview-page task-overview-page--home">
      <TopLine
        pageTitle="工作台"
        crumbExtra={formatTodayCrumb()}
        scopeLabel={scopeLabel}
      />

      <header className="task-overview-hero">
        <div className="task-overview-hero-copy">
          <h1>只在需要时介入</h1>
          <p>
            {subtitle ?? 'Peer 持续推进任务，仅在需要你决策、授权或验收时交还给你。'}
          </p>
        </div>
        <div className="task-overview-hero-stats">
          <div className="task-overview-stat">
            <b>{needsYou.length}</b>
            <span>轮到你</span>
          </div>
          <div className="task-overview-stat">
            <b>{advancing.length}</b>
            <span>Peer 推进</span>
          </div>
          <div className="task-overview-stat">
            <b>{resultReady.length}</b>
            <span>结果待验收</span>
          </div>
        </div>
      </header>

      {!hasAny ? (
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
      ) : null}

      {needsYou.length > 0 ? (
        <section className="task-overview-section">
          <div className="task-overview-section-head">
            <div className="task-overview-section-title">
              <h2>需要你处理</h2>
              <small>{needsYou.length}</small>
            </div>
            <span className="task-overview-section-meta">决策与权限</span>
          </div>
          <div className="task-overview-handoff-list">
            {needsYou.map((item) => (
              <HandoffRow key={item.taskId} item={item} onOpenItem={onOpenItem} />
            ))}
          </div>
        </section>
      ) : null}

      {advancing.length > 0 ? (
        <section className="task-overview-section">
          <div className="task-overview-section-head">
            <div className="task-overview-section-title">
              <h2>Peer 正在推进</h2>
              <small>{advancing.length}</small>
            </div>
            {onOpenTasks ? (
              <SectionLink label="查看全部任务" onClick={onOpenTasks} />
            ) : (
              <span className="task-overview-section-meta">Peer 会在完成后带回结果</span>
            )}
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

      {discussions.length > 0 ? (
        <section className="task-overview-section task-overview-section--discussion">
          <div className="task-overview-section-head">
            <div className="task-overview-section-title">
              <h2>正在讨论</h2>
              <small>{discussions.length}</small>
            </div>
            {onOpenTasks ? (
              <SectionLink
                label="查看全部"
                count={hiddenDiscussionCount}
                countHint={`还有 ${hiddenDiscussionCount} 条`}
                onClick={onOpenTasks}
              />
            ) : (
              <span className="task-overview-section-meta">未读沟通</span>
            )}
          </div>
          <div className="task-overview-discussion-grid">
            {visibleDiscussions.map((item) => (
              <DiscussionCard key={item.taskId} item={item} onOpenItem={onOpenItem} />
            ))}
          </div>
        </section>
      ) : null}

      {displayedResults.length > 0 ? (
        <section className="task-overview-section result-section">
          <div className="task-overview-section-head">
            <div className="task-overview-section-title">
              <h2>结果待验收</h2>
              <small>{displayedResults.length}</small>
            </div>
            {onOpenHistory ? (
              <SectionLink label="查看历史" onClick={onOpenHistory} />
            ) : (
              <span className="task-overview-section-meta">Peer 已完成并带回 Evidence</span>
            )}
          </div>
          {/* 与「Peer 正在推进」同款双列卡片网格，不再一排一条 */}
          <div className="task-overview-work-stream">
            {displayedResults.map(({ item, phase }) => (
              <ResultCard
                key={item.taskId}
                item={item}
                phase={phase ?? null}
                onOpenItem={onOpenItem}
                onAcceptResult={handleAccept}
              />
            ))}
          </div>
        </section>
      ) : null}
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
function HandoffRow({
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
    <div className="task-overview-handoff-row">
      <div className="task-overview-task-copy">
        <strong>{item.title}</strong>
        <span>
          {item.workspaceLabel ?? 'workspace'} · {formatRelativeTime(item.lastActiveAt)}
        </span>
      </div>
      <div className="task-overview-owner">
        <i>你</i>
        <span>{ownerLabel(item)}</span>
      </div>
      <div className="task-overview-handoff-reason">
        <strong>{reasonTitle(item)}</strong>
        <span>{reasonMeta(item)}</span>
      </div>
      <button
        type="button"
        className={primary ? 'task-overview-btn task-overview-btn--primary' : 'task-overview-btn task-overview-btn--secondary'}
        onClick={() => onOpenItem?.(item)}
      >
        {item.actionLabel}
      </button>
    </div>
  );
}

/** 无计划讨论卡：只表达讨论上下文，不复用执行状态或进度。 */
function DiscussionCard({
  item,
  onOpenItem,
}: {
  readonly item: TaskOverviewItem;
  readonly onOpenItem?: (item: TaskOverviewItem) => void;
}) {
  return (
    <article
      className={`task-overview-discussion-card${onOpenItem ? ' is-clickable' : ''}`}
      onClick={() => onOpenItem?.(item)}
    >
      <div className="task-overview-discussion-card__meta">
        <span className="task-overview-discussion-card__status">
          <i aria-hidden="true" />
          {item.statusLabel || '有未读'}
        </span>
        <time>{formatRelativeTime(item.lastActiveAt)}</time>
      </div>
      <h3>{item.title}</h3>
      <div className="task-overview-discussion-card__footer">
        <span>{item.workspaceLabel ?? '当前 Workspace'}</span>
        <strong>{item.actionLabel || '打开'}</strong>
      </div>
    </article>
  );
}

/** 推进中工作卡：状态 + 标题 + 进度条 + 取消 */
function WorkItem({
  item,
  onOpenItem,
  onCancelItem,
}: {
  readonly item: TaskOverviewItem;
  readonly onOpenItem?: (item: TaskOverviewItem) => void;
  readonly onCancelItem?: (item: TaskOverviewItem) => void | Promise<void>;
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
          {item.source !== 'conversation' ? (
            <i className="task-overview-spinner" aria-hidden="true" />
          ) : null}
          {advancingStateLabel(item)}
        </span>
        <WorkItemMeta item={item} />
      </div>
      <h3>{item.title}</h3>
      {item.currentGoalTitle ? (
        <p className="task-overview-current-goal">当前目标 · {item.currentGoalTitle}</p>
      ) : null}
      <p>{item.source === 'conversation' ? '继续讨论，或在明确实施时创建 GoalPlan' : reasonMeta(item)}</p>
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
      {canCancel ? (
        <div className="result-card-actions work-item-actions">
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
        </div>
      ) : null}
    </article>
  );
}


/** 结果待验收卡片 —— 与推进中同款双列卡片：顶栏状态 + 标题 + 摘要 + 操作 */
function ResultCard({
  item,
  phase,
  onOpenItem,
  onAcceptResult,
}: {
  readonly item: TaskOverviewItem;
  readonly phase: AcceptancePhase | null;
  readonly onOpenItem?: (item: TaskOverviewItem) => void;
  readonly onAcceptResult?: (item: TaskOverviewItem) => void | Promise<void>;
}) {
  const cardRef = useRef<HTMLElement | null>(null);
  const summary = item.planProgress
    ? `${item.planProgress.total} 项标准通过 · ${item.planProgress.completed} 项完成 · 无已知风险`
    : 'Peer 已完成并带回 Evidence · 无已知风险';
  const canAccept = item.source === 'goal_plan' && typeof onAcceptResult === 'function';
  const pct = progressPercent(item);
  const celebrating = phase === 'celebrating' || phase === 'exiting';
  const shattering = celebrating;
  return (
    <div className={`particle-shatter-host${phase === 'exiting' ? ' is-exiting' : ''}`}>
    <article
      ref={cardRef}
      className={`task-overview-work-item task-overview-work-item--result_ready result-card particle-shatter-source${phase === 'submitting' ? ' result-card--submitting' : ''}${shattering ? ' is-shattering' : ''}`}
    >
      <div className="task-overview-work-top">
        <span className="task-overview-work-state result-card-state">
          <i className="result-card-seal" aria-hidden="true">
            ✓
          </i>
          {celebrating ? '验收完成，任务已圆满结束' : '等待验收'}
        </span>
        <WorkItemMeta item={item} fallbackWhenEmpty="READY" />
      </div>
      <h3>{item.title}</h3>
      <p>{summary}</p>
      {item.planProgress ? (
        <div className="task-overview-progress" aria-hidden="true">
          <i style={{ width: `${pct}%` }} />
        </div>
      ) : null}
      <div className="result-card-actions">
        {onOpenItem ? (
          <button
            type="button"
            className="task-overview-btn task-overview-btn--secondary"
            disabled={Boolean(phase)}
            onClick={() => onOpenItem(item)}
          >
            查看结果
          </button>
        ) : null}
        <button
          type="button"
          className="task-overview-btn task-overview-btn--primary result-card-accept"
          disabled={!canAccept || Boolean(phase)}
          onClick={() => {
            if (canAccept) void onAcceptResult?.(item);
            else onOpenItem?.(item);
          }}
        >
          {phase === 'submitting' ? (
            <>
              <span className="result-card-spinner" aria-hidden="true" />
              正在验收…
            </>
          ) : null}
          {celebrating ? '已验收 ✓' : null}
          {phase === null ? '确认验收' : null}
        </button>
      </div>
    </article>
      <ParticleShatterOverlay active={shattering} targetRef={cardRef} />
    </div>
  );
}

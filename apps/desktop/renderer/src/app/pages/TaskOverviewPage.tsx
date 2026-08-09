import type { TaskOverviewItem } from '@peer-agent/protocol';
import { useTaskOverview } from '../hooks/useTaskOverview';

/**
 * TaskOverview 页面 —— 对齐 peer-2-0 高保真原型工作台结构。
 *
 * 工作台：topline（面包屑 + Workspace）+ hero（说明 + 统计）
 * + 需要你处理（四列交接卡）+ Peer 正在推进（双列 + 进度条）
 * + 结果待验收。
 *
 * 任务/历史页：统一列表（也可由 Drawer 承载）。
 * 行动权分桶只消费 TaskOverviewItem.actionRight，前端不解析状态机。
 *
 * 结果待验收：卡片叠放展示全部未验收 completed（不限条数）；
 * 主按钮「确认验收」一键落库，次按钮「查看结果」可选进会话。
 */

interface TaskOverviewPageProps {
  readonly title: string;
  readonly subtitle?: string;
  readonly filter: (item: TaskOverviewItem) => boolean;
  readonly emptyLabel?: string;
  readonly hero?: boolean;
  readonly workspacePath?: string | null;
  readonly includeTerminal?: boolean;
  readonly onOpenTasks?: () => void;
  readonly onOpenHistory?: () => void;
  /** 打开对应会话（决策 / 查看结果）。 */
  readonly onOpenItem?: (item: TaskOverviewItem) => void;
  /** 工作台一键确认验收（仅 goal_plan）。 */
  readonly onAcceptResult?: (item: TaskOverviewItem) => void | Promise<void>;
  /** 取消正在推进的 GoalPlan（仅 goal_plan）。 */
  readonly onCancelItem?: (item: TaskOverviewItem) => void | Promise<void>;
}

function workspaceLabelFromPath(workspacePath: string | null | undefined): string {
  if (!workspacePath) return '未绑定 Workspace';
  const seg = workspacePath.replace(/[/\\]+$/, '').split(/[/\\]/).filter(Boolean).pop();
  return seg || workspacePath;
}

function formatRelativeTime(iso?: string): string {
  if (!iso) return '刚刚更新';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const diffMs = Date.now() - t;
  if (diffMs < 60_000) return '刚刚更新';
  if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)} 分钟前`;
  if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)} 小时前`;
  if (diffMs < 7 * 86_400_000) return `${Math.floor(diffMs / 86_400_000)} 天前`;
  return new Date(t).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
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

const DISCUSSION_PREVIEW_LIMIT = 6;

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
  onOpenItem,
  onAcceptResult,
  onCancelItem,
}: TaskOverviewPageProps) {
  const items = useTaskOverview({ workspacePath, includeTerminal });
  const filtered = items.filter(filter);
  const scopeLabel = workspaceLabelFromPath(workspacePath);

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
        当前 Workspace · {scopeLabel}
      </div>
    </div>
  );
}

function HeroLayout({
  title: _title,
  subtitle,
  items,
  emptyLabel,
  scopeLabel,
  onOpenTasks,
  onOpenHistory,
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
  const hasAny = discussions.length + needsYou.length + advancing.length + resultReady.length > 0;

  return (
    <div className="task-overview-page task-overview-page--home">
      <TopLine pageTitle="工作台" crumbExtra={formatTodayCrumb()} scopeLabel={scopeLabel} />

      <header className="task-overview-hero">
        <div className="task-overview-hero-copy">
          <div className="task-overview-kicker">Delegation OS</div>
          <h1>只处理真正需要你的事</h1>
          <p>
            {subtitle ??
              '工作台不是任务仓库，而是所有任务按下一步行动权形成的动态投影。Peer 推进其余工作，只在决策、权限与验收时交还给你。'}
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
        </div>
      ) : null}

      {discussions.length > 0 ? (
        <section className="task-overview-section">
          <div className="task-overview-section-head">
            <div className="task-overview-section-title">
              <h2>最近讨论</h2>
              <small>{discussions.length}</small>
            </div>
            {onOpenTasks ? (
              <button
                type="button"
                className="task-overview-section-link task-overview-section-link--button"
                onClick={onOpenTasks}
              >
                {hiddenDiscussionCount > 0 ? `查看全部讨论 · 还有 ${hiddenDiscussionCount} 条 →` : '查看全部讨论 →'}
              </button>
            ) : (
              <span className="task-overview-section-link">尚无执行计划</span>
            )}
          </div>
          <div className="task-overview-discussion-grid">
            {visibleDiscussions.map((item) => (
              <DiscussionCard key={item.taskId} item={item} onOpenItem={onOpenItem} />
            ))}
          </div>
        </section>
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
              <button type="button" className="task-overview-section-meta task-overview-section-link" onClick={onOpenTasks}>
                查看全部任务 →
              </button>
            ) : (
              <span className="task-overview-section-meta">查看全部任务 →</span>
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

      {resultReady.length > 0 ? (
        <section className="task-overview-section result-section">
          <div className="task-overview-section-head">
            <div className="task-overview-section-title">
              <h2>结果待验收</h2>
              <small>{resultReady.length}</small>
            </div>
            {onOpenHistory ? (
              <button type="button" className="task-overview-section-meta task-overview-section-link" onClick={onOpenHistory}>
                查看历史 →
              </button>
            ) : (
              <span className="task-overview-section-meta">Peer 已完成并带回 Evidence</span>
            )}
          </div>
          {/* 与「Peer 正在推进」同款双列卡片网格，不再一排一条 */}
          <div className="task-overview-work-stream">
            {resultReady.map((item) => (
              <ResultCard
                key={item.taskId}
                item={item}
                onOpenItem={onOpenItem}
                onAcceptResult={onAcceptResult}
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
        <div className="task-overview-kicker">Delegation OS</div>
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
          {item.statusLabel || '讨论中'}
        </span>
        <time>{formatRelativeTime(item.lastActiveAt)}</time>
      </div>
      <h3>{item.title}</h3>
      <div className="task-overview-discussion-card__footer">
        <span>{item.workspaceLabel ?? '当前 Workspace'}</span>
        <strong>{item.actionLabel || '继续讨论 →'}</strong>
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
        <time>{item.lastActiveAt ? formatRelativeTime(item.lastActiveAt) : 'LIVE'}</time>
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
  onOpenItem,
  onAcceptResult,
}: {
  readonly item: TaskOverviewItem;
  readonly onOpenItem?: (item: TaskOverviewItem) => void;
  readonly onAcceptResult?: (item: TaskOverviewItem) => void | Promise<void>;
}) {
  const summary = item.planProgress
    ? `${item.planProgress.total} 项标准通过 · ${item.planProgress.completed} 项完成 · 无已知风险`
    : 'Peer 已完成并带回 Evidence · 无已知风险';
  const canAccept = item.source === 'goal_plan' && typeof onAcceptResult === 'function';
  const pct = progressPercent(item);
  return (
    <article className="task-overview-work-item task-overview-work-item--result_ready result-card">
      <div className="task-overview-work-top">
        <span className="task-overview-work-state result-card-state">
          <i className="result-card-seal" aria-hidden="true">
            ✓
          </i>
          等待验收
        </span>
        <time>{item.lastActiveAt ? formatRelativeTime(item.lastActiveAt) : 'READY'}</time>
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
            onClick={() => onOpenItem(item)}
          >
            查看结果
          </button>
        ) : null}
        <button
          type="button"
          className="task-overview-btn task-overview-btn--primary"
          disabled={!canAccept}
          onClick={() => {
            if (canAccept) void onAcceptResult?.(item);
            else onOpenItem?.(item);
          }}
        >
          确认验收
        </button>
      </div>
    </article>
  );
}

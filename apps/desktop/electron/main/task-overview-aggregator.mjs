/**
 * TaskOverview 聚合器 —— Peer 2.0 阶段 1（main 进程聚合层）。
 *
 * 设计依据：peer-knowledge design/product/peer-2-0-gap-analysis.md §11。
 *
 * 职责（治理红线见 AGENTS.md）：
 * - 这是 renderer 之外唯一组装「行动权投影」的地方。
 * - 从 goal-plan-store 与 automation-store 读出存储事实，组装成
 *   protocol 的最小输入快照（ProjectionSnapshot），再调用 protocol 的
 *   projectGoalPlan / projectAutomationRun 得到 TaskOverviewItem。
 * - renderer 只消费本模块输出的投影产物（经 taskOverview:list /
 *   taskOverview:changed），不自行解析状态机推断行动权。
 *
 * 数据边界（首页对齐设计稿，2026-08-08）：
 * - 默认只投影「当前 Workspace + 非终态/近期活跃」任务，避免历史全量灌首页。
 * - 支持 workspacePath / includeTerminal / activeWithinMs / limit 过滤。
 *
 * 纯函数 + 依赖注入：本模块不直接持有 store，由 main.mjs 注入
 * goalPlanStore / automationStore，便于单测。
 */

import {
  projectAutomationRun,
  projectConversation,
  projectGoalPlan,
  projectShellBackgroundTask,
} from '@peer-agent/protocol';

/** 工作台默认只看近 7 天活跃任务（推进中 / 待你处理）。 */
export const DEFAULT_ACTIVE_WITHIN_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * @deprecated 不再用短窗藏 completed；存量用 RESULT_ACCEPTANCE_REQUIRED_SINCE 祖父化。
 * 保留导出以免外部 import 断裂。
 */
export const DEFAULT_RESULT_READY_WITHIN_MS = 0;
/** 工作台默认最多返回条数（三桶合计）。0/不传时用此默认；result_ready 本身不单独限条。 */
export const DEFAULT_HOME_LIMIT = 200;
/**
 * @deprecated result_ready 不单独限流；保留导出，默认 Infinity 语义用极大值。
 */
export const DEFAULT_RESULT_READY_LIMIT = Number.MAX_SAFE_INTEGER;

/**
 * 一键验收功能生效起点（ISO）。
 * 此时间点之前完成的 completed 一律祖父化为「已结束」，不进「结果待验收」，
 * 避免把历史海量任务甩给用户白点。此时间点之后的新完成项才需要工作台一键确认。
 *
 * 产品决策：存量不进待验收；上线后新会话/新完成项走工作台闭环。
 */
export const RESULT_ACCEPTANCE_REQUIRED_SINCE = '2026-08-08T11:00:00.000Z';

// cancelled/failed 为历史终态；completed 未验收（且在功能上线后）→ result_ready。
const GOAL_HISTORY_TERMINAL_STATUSES = new Set(['cancelled', 'failed']);
const GOAL_COMPLETED_STATUS = 'completed';
const AUTOMATION_DEF_TERMINAL_STATUSES = new Set(['completed', 'archived']);
const AUTOMATION_RUN_TERMINAL_STATUSES = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'skipped',
  'timed_out',
  'blocked',
]);

function normalizedTitle(value, fallback) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
}

/** 从 workspace 绝对路径提取卡片右上角标签（取末段目录名）。 */
function workspaceLabelFromPath(workspacePath) {
  if (typeof workspacePath !== 'string' || workspacePath.trim() === '') return undefined;
  const normalized = workspacePath.replace(/[/\\]+$/, '');
  const segment = normalized.split(/[/\\]/).filter(Boolean).pop();
  return segment || undefined;
}

/** 归一化路径便于比较（去尾斜杠 + 小写兼容）。 */
export function normalizeWorkspacePath(workspacePath) {
  if (typeof workspacePath !== 'string' || workspacePath.trim() === '') return null;
  return workspacePath.replace(/[/\\]+$/, '').toLowerCase();
}

function isWithinActiveWindow(iso, activeWithinMs, nowMs) {
  if (!Number.isFinite(activeWithinMs) || activeWithinMs <= 0) return true;
  if (typeof iso !== 'string' || iso.trim() === '') return false;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return false;
  return nowMs - t <= activeWithinMs;
}

function planWorkspacePath(plan) {
  // 工作台归属跟随发起会话；targetWorkspacePath 仅描述实际执行仓库。
  // 回退 target 只用于兼容尚未持久化 originWorkspacePath 的旧计划。
  return plan?.originWorkspacePath ?? plan?.targetWorkspacePath ?? null;
}

const PLAN_STEP_STATUSES = new Set([
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
  'waiting_user',
]);

/**
 * 从 GoalPlan 任务树抽取叶子步骤（与 progress 叶子计数对齐）。
 * 供「Peer 正在推进」卡片展示具体步骤标题与状态。
 */
export function extractPlanSteps(plan) {
  if (!plan || typeof plan !== 'object') return undefined;
  const currentTaskId =
    typeof plan.runner?.currentTaskId === 'string'
      ? plan.runner.currentTaskId
      : typeof plan.currentTaskId === 'string'
        ? plan.currentTaskId
        : undefined;
  const steps = [];
  const walk = (list) => {
    for (const task of Array.isArray(list) ? list : []) {
      if (!task || typeof task !== 'object') continue;
      const children = Array.isArray(task.subtasks) ? task.subtasks : [];
      if (children.length > 0) {
        walk(children);
        continue;
      }
      const taskId = typeof task.taskId === 'string' ? task.taskId : null;
      const title =
        typeof task.title === 'string' && task.title.trim() !== ''
          ? task.title.trim()
          : taskId;
      if (!taskId || !title) continue;
      const rawStatus = typeof task.status === 'string' ? task.status : 'pending';
      const status = PLAN_STEP_STATUSES.has(rawStatus) ? rawStatus : 'pending';
      const step = { taskId, title, status };
      if (currentTaskId && taskId === currentTaskId) step.current = true;
      steps.push(step);
    }
  };
  walk(plan.tasks);
  return steps.length > 0 ? steps : undefined;
}

/** 组装 GoalPlan 投影快照。plan 为 goal-plan-store.listPlanDetails() 的水合形态。 */
export function toGoalPlanSnapshot(plan) {
  if (!plan || typeof plan !== 'object') return null;
  const planId = typeof plan.planId === 'string' ? plan.planId : null;
  const status = typeof plan.status === 'string' ? plan.status : null;
  if (!planId || !status) return null;
  const workspacePath = planWorkspacePath(plan);
  const progress =
    plan.progress && Number.isFinite(plan.progress.completed) && Number.isFinite(plan.progress.total)
      ? { completed: plan.progress.completed, total: plan.progress.total }
      : undefined;
  const planSteps = extractPlanSteps(plan);
  return {
    planId,
    status,
    runnerStatus: plan.runner?.status,
    // 展示名 = 核对后的 plan 名字（GoalPlan.title），不用 goal 全文、不用会话名。
    title: typeof plan.title === 'string' && plan.title.trim() !== '' ? plan.title.trim() : planId,
    workspaceLabel: workspaceLabelFromPath(workspacePath),
    progress,
    ...(planSteps ? { planSteps } : {}),
    updatedAt: typeof plan.updatedAt === 'string' ? plan.updatedAt : undefined,
    conversationId: typeof plan.conversationId === 'string' ? plan.conversationId : undefined,
    // USER ACCEPTANCE：一键确认写 resultAcceptance；存量 completed 按上线截止祖父化。
    accepted: isPlanResultAccepted(plan),
  };
}

/**
 * 组装 Automation 投影快照（Definition 与最新一次 Run 联合）。
 * definition 为 automation-store.listDefinitions() 元素，
 * latestRun 为 automation-store.listRuns({ automationId, limit: 1 })[0]。
 */
export function toAutomationSnapshot(definition, latestRun) {
  if (!definition || typeof definition !== 'object') return null;
  const automationId =
    typeof definition.automationId === 'string'
      ? definition.automationId
      : typeof definition.id === 'string'
        ? definition.id
        : null;
  const definitionStatus =
    typeof definition.status === 'string' ? definition.status : null;
  if (!automationId || !definitionStatus) return null;
  return {
    automationId,
    runId: typeof latestRun?.runId === 'string' ? latestRun.runId : undefined,
    definitionStatus,
    runStatus: typeof latestRun?.status === 'string' ? latestRun.status : undefined,
    title:
      typeof definition.name === 'string' && definition.name.trim() !== ''
        ? definition.name
        : automationId,
    workspaceLabel: workspaceLabelFromPath(definition.workspacePath),
    updatedAt:
      typeof latestRun?.updatedAt === 'string'
        ? latestRun.updatedAt
        : typeof definition.updatedAt === 'string'
          ? definition.updatedAt
          : undefined,
    conversationId:
      typeof latestRun?.conversationId === 'string' ? latestRun.conversationId : undefined,
    // 方案 A：Automation 不走 Goal 验收；succeeded 由投影直接 terminal，accepted 无实际门闩作用
    accepted: false,
  };
}

/**
 * 判断 GoalPlan 是否应进入工作台 / 历史投影。
 * - 默认排除 cancelled/failed，除非 includeTerminal（历史页）。
 * - completed：
 *   - 已验收 / 存量祖父化 → 仅 includeTerminal 时纳入（历史）
 *   - 功能上线后未验收 → 工作台纳入（result_ready），不限条数；历史页也纳入（列表可再滤 terminal）
 * - 其他活跃状态要求在 activeWithinMs 窗口内（activeWithinMs<=0 表示不限时）。
 * - workspacePath 过滤（target/origin 任一匹配）。
 * - 展示名固定使用 plan.title（核对后的 plan 名字）。
 */
export function isGoalPlanInScope(plan, options = {}) {
  if (!plan || typeof plan !== 'object') return false;
  const {
    workspacePath = null,
    includeTerminal = false,
    activeWithinMs = DEFAULT_ACTIVE_WITHIN_MS,
    nowMs = Date.now(),
  } = options;

  const status = typeof plan.status === 'string' ? plan.status : null;
  if (!status) return false;

  const isHistoryTerminal = GOAL_HISTORY_TERMINAL_STATUSES.has(status);
  const isCompleted = status === GOAL_COMPLETED_STATUS;
  const isResultAccepted = isPlanResultAccepted(plan);

  // cancelled/failed：只在历史页
  if (isHistoryTerminal && !includeTerminal) return false;

  // 已验收 completed：工作台不展示，历史页展示
  if (isCompleted && isResultAccepted && !includeTerminal) return false;

  const wanted = normalizeWorkspacePath(workspacePath);
  if (wanted) {
    const planWs = normalizeWorkspacePath(planWorkspacePath(plan));
    if (!planWs || planWs !== wanted) return false;
  }

  const updatedAt = typeof plan.updatedAt === 'string' ? plan.updatedAt : null;

  if (isCompleted) {
    // 未验收：工作台全量；已验收：仅 includeTerminal 走到这里
    // completed 不再套用 activeWithinMs 短窗（产品：result_ready 不限制）
    return true;
  }

  // 非 completed：活跃任务窗口
  if (updatedAt && activeWithinMs > 0) {
    if (!isWithinActiveWindow(updatedAt, activeWithinMs, nowMs)) return false;
  } else if (isHistoryTerminal) {
    return false;
  }

  return true;
}

/** 用户是否已在工作台一键确认过结果（与 GoalPlanStatus.accepted 无关）。 */
/**
 * 用户是否已验收结果（与 GoalPlanStatus.accepted 无关）。
 * - 显式 resultAcceptance / resultAccepted* → 已验收
 * - completed 且完成时间早于 RESULT_ACCEPTANCE_REQUIRED_SINCE → 祖父化为已结束（存量不进待验收）
 * - 功能上线后的 completed 无验收记录 → 未验收 → result_ready
 */
export function isPlanResultAccepted(plan) {
  if (!plan || typeof plan !== 'object') return false;
  const ra = plan.resultAcceptance;
  if (ra && typeof ra === 'object') {
    if (typeof ra.acceptedAt === 'string' && ra.acceptedAt.trim() !== '') return true;
    if (ra.accepted === true) return true;
  }
  // 兼容：若将来落到顶层字段
  if (plan.resultAccepted === true) return true;
  if (typeof plan.resultAcceptedAt === 'string' && plan.resultAcceptedAt.trim() !== '') return true;

  // 存量祖父化：功能上线前的 completed 视为已结束，不进「结果待验收」
  const status = typeof plan.status === 'string' ? plan.status : null;
  if (status === GOAL_COMPLETED_STATUS) {
    const when =
      (typeof plan.updatedAt === 'string' && plan.updatedAt) ||
      (typeof plan.completedAt === 'string' && plan.completedAt) ||
      (typeof plan.createdAt === 'string' && plan.createdAt) ||
      null;
    if (when && when < RESULT_ACCEPTANCE_REQUIRED_SINCE) {
      return true;
    }
  }
  return false;
}

/**
 * 判断 Automation 是否应进入首页投影。
 * - definition completed/archived 默认排除。
 * - 有 run 时：终态 run（含 succeeded）默认排除；方案 A 成功即归档不进工作台。
 * - 无 run 时：active/draft 定义可纳入（调度待机）。
 */
export function isAutomationInScope(definition, latestRun, options = {}) {
  if (!definition || typeof definition !== 'object') return false;
  const {
    workspacePath = null,
    includeTerminal = false,
    activeWithinMs = DEFAULT_ACTIVE_WITHIN_MS,
    nowMs = Date.now(),
  } = options;

  const definitionStatus =
    typeof definition.status === 'string' ? definition.status : null;
  if (!definitionStatus) return false;
  if (AUTOMATION_DEF_TERMINAL_STATUSES.has(definitionStatus) && !includeTerminal) {
    return false;
  }

  const wanted = normalizeWorkspacePath(workspacePath);
  if (wanted) {
    const defWs = normalizeWorkspacePath(definition.workspacePath);
    if (!defWs || defWs !== wanted) return false;
  }

  if (latestRun && typeof latestRun === 'object') {
    const runStatus = typeof latestRun.status === 'string' ? latestRun.status : null;
    const runTerminal = runStatus && AUTOMATION_RUN_TERMINAL_STATUSES.has(runStatus);
    // 方案 A：succeeded 也是终态，工作台默认不收（仅 needs_you / 推进中进工作台）
    if (runTerminal && !includeTerminal) return false;
    const updatedAt =
      typeof latestRun.updatedAt === 'string'
        ? latestRun.updatedAt
        : typeof definition.updatedAt === 'string'
          ? definition.updatedAt
          : null;
    if (updatedAt && !isWithinActiveWindow(updatedAt, activeWithinMs, nowMs)) return false;
  } else if (definitionStatus !== 'active' && definitionStatus !== 'draft') {
    return false;
  }

  return true;
}

/**
 * 创建 TaskOverview 聚合器。
 *
 * @param {object} deps
 * @param {{ listPlanDetails: () => Array }} deps.goalPlanStore
 * @param {{ listDefinitions: (opts?: object) => Array, listRuns: (opts?: object) => Array }} deps.automationStore
 * @param {(() => Array)|undefined} deps.listConversations
 */
export function createTaskOverviewAggregator({
  goalPlanStore,
  automationStore,
  listConversations,
  listShellTasks,
} = {}) {
  if (!goalPlanStore || typeof goalPlanStore.listPlanDetails !== 'function') {
    throw new TypeError('goalPlanStore.listPlanDetails must be a function');
  }
  if (
    !automationStore ||
    typeof automationStore.listDefinitions !== 'function' ||
    typeof automationStore.listRuns !== 'function'
  ) {
    throw new TypeError('automationStore.listDefinitions/listRuns must be functions');
  }
  // listShellTasks 可选：localToolHost 尚未就绪时静默跳过后台线程投影。

  /**
   * 聚合并投影任务，按行动权排序后截断。
   *
   * @param {object} [query]
   * @param {string|null} [query.workspacePath] 当前 Workspace 绝对路径；缺省不过滤。
   * @param {boolean} [query.includeTerminal=false] 是否包含终态（历史页传 true）。
   * @param {number} [query.activeWithinMs] 活跃窗口毫秒；默认 7 天。
   * @param {number} [query.limit] 返回条数上限；默认 48。
   * @returns {Array<import('@peer-agent/protocol').TaskOverviewItem>}
   */
  function listTaskOverview(query = {}) {
    const workspacePath =
      typeof query?.workspacePath === 'string' && query.workspacePath.trim() !== ''
        ? query.workspacePath
        : null;
    const includeTerminal = query?.includeTerminal === true;
    const activeWithinMs = Number.isFinite(query?.activeWithinMs)
      ? query.activeWithinMs
      : DEFAULT_ACTIVE_WITHIN_MS;
    const limit = Number.isFinite(query?.limit) && query.limit > 0
      ? Math.floor(query.limit)
      : DEFAULT_HOME_LIMIT;
    const nowMs = Date.now();
    // result_ready 不限流：不再传 resultReadyWithinMs / resultReadyLimit
    const scope = { workspacePath, includeTerminal, activeWithinMs, nowMs };

    /** @type {Array<import('@peer-agent/protocol').TaskOverviewItem>} */
    const items = [];

    let conversations = [];
    if (typeof listConversations === 'function') {
      try {
        conversations = listConversations({ status: 'active' }) ?? [];
      } catch {
        conversations = [];
      }
    }
    const conversationById = new Map(
      conversations
        .filter((conversation) => typeof conversation?.id === 'string' && conversation.id.trim() !== '')
        .map((conversation) => [conversation.id, conversation]),
    );
    const projectedPlanConversationIds = new Set();

    let plans = [];
    try {
      plans = goalPlanStore.listPlanDetails() ?? [];
    } catch {
      plans = [];
    }
    const latestPlanByConversationId = new Map();
    const unlinkedPlans = [];
    for (const plan of plans) {
      if (!isGoalPlanInScope(plan, scope)) continue;
      const conversationId = typeof plan?.conversationId === 'string' ? plan.conversationId : '';
      if (!conversationId) {
        unlinkedPlans.push(plan);
        continue;
      }
      const current = latestPlanByConversationId.get(conversationId);
      const currentUpdatedAt = Date.parse(current?.updatedAt ?? current?.createdAt ?? '');
      const nextUpdatedAt = Date.parse(plan?.updatedAt ?? plan?.createdAt ?? '');
      if (!current || !Number.isFinite(currentUpdatedAt) || nextUpdatedAt >= currentUpdatedAt) {
        latestPlanByConversationId.set(conversationId, plan);
      }
    }
    for (const plan of [...latestPlanByConversationId.values(), ...unlinkedPlans]) {
      const snapshot = toGoalPlanSnapshot(plan);
      if (!snapshot) continue;
      const projected = projectGoalPlan(snapshot);
      const conversation = snapshot.conversationId
        ? conversationById.get(snapshot.conversationId)
        : undefined;
      if (conversation) {
        projectedPlanConversationIds.add(snapshot.conversationId);
        items.push({
          ...projected,
          title: normalizedTitle(conversation.title, projected.title),
          currentGoalTitle: projected.title,
        });
      } else {
        items.push(projected);
      }
    }

    for (const conversation of conversations) {
      const conversationId =
        typeof conversation?.id === 'string' ? conversation.id.trim() : '';
      if (!conversationId || projectedPlanConversationIds.has(conversationId)) continue;
      if (
        workspacePath &&
        normalizeWorkspacePath(conversation.workspacePath) !== normalizeWorkspacePath(workspacePath)
      ) {
        continue;
      }
      if (
        activeWithinMs > 0 &&
        !isWithinActiveWindow(conversation.updatedAt, activeWithinMs, nowMs)
      ) {
        continue;
      }
      items.push(projectConversation({
        conversationId,
        title: normalizedTitle(conversation.title, '新对话'),
        workspaceLabel: workspaceLabelFromPath(conversation.workspacePath),
        updatedAt: conversation.updatedAt,
      }));
    }

    let definitions = [];
    try {
      definitions = automationStore.listDefinitions() ?? [];
    } catch {
      definitions = [];
    }
    for (const definition of definitions) {
      const automationId = definition?.automationId ?? definition?.id;
      let latestRun;
      if (automationId) {
        try {
          latestRun = automationStore.listRuns({ automationId, limit: 1 })?.[0];
        } catch {
          latestRun = undefined;
        }
      }
      if (!isAutomationInScope(definition, latestRun, scope)) continue;
      const snapshot = toAutomationSnapshot(definition, latestRun);
      if (!snapshot) continue;
      items.push(projectAutomationRun(snapshot));
    }

    // Peer 开启的后台 shell 线程：工作台「Peer 正在推进」桶。
    let shellTasks = [];
    if (typeof listShellTasks === 'function') {
      try {
        const listed = listShellTasks();
        shellTasks = Array.isArray(listed) ? listed : [];
      } catch {
        shellTasks = [];
      }
    }
    for (const task of shellTasks) {
      const projected = projectShellTaskIfInScope(task, scope);
      if (projected) items.push(projected);
    }

    const sorted = sortTaskOverview(items);
    // result_ready 不单独限流；仅受首页合计 limit 约束（默认放宽到 200）。
    return sorted.slice(0, limit);
  }

  return Object.freeze({ listTaskOverview });
}

/**
 * 将 runtime shell task 快照投影为 TaskOverviewItem；不在当前 workspace / 不在活跃窗时返回 null。
 * 工作台默认只展示 running；includeTerminal 时也展示已结束任务。
 */
export function projectShellTaskIfInScope(task, scope = {}) {
  if (!task || typeof task !== 'object') return null;
  const taskId = typeof task.taskId === 'string' ? task.taskId.trim() : '';
  if (!taskId) return null;
  const status = String(task.status ?? '').trim().toLowerCase();
  const running = status === 'running' || status === '';
  if (!running && scope.includeTerminal !== true) return null;

  const cwd = typeof task.cwd === 'string' ? task.cwd : '';
  const wanted = normalizeWorkspacePath(scope.workspacePath);
  if (wanted) {
    const taskWs = normalizeWorkspacePath(cwd);
    // cwd 通常是 workspace 内路径；用前缀匹配覆盖子目录 cwd。
    if (taskWs && taskWs !== wanted && !taskWs.startsWith(`${wanted}/`) && !wanted.startsWith(`${taskWs}/`)) {
      return null;
    }
  }

  const startedAt = typeof task.startedAt === 'string' ? task.startedAt : undefined;
  const completedAt =
    typeof task.completedAt === 'string' && task.completedAt.trim() !== ''
      ? task.completedAt
      : null;
  const activeIso = completedAt || startedAt;
  if (
    !running &&
    !isWithinActiveWindow(activeIso, scope.activeWithinMs, scope.nowMs ?? Date.now())
  ) {
    return null;
  }

  return projectShellBackgroundTask({
    taskId,
    command: typeof task.command === 'string' ? task.command : '',
    status: running ? 'running' : status,
    workspaceLabel: workspaceLabelFromPath(cwd),
    cwd: cwd || undefined,
    startedAt,
    completedAt,
    toolCallId: typeof task.toolCallId === 'string' ? task.toolCallId : undefined,
  });
}

const ACTION_RIGHT_ORDER = {
  needs_you: 0,
  result_ready: 1,
  peer_advancing: 2,
  paused: 3,
  terminal: 4,
};

/** 行动权分组排序 + 组内最近活跃倒序（稳定，不破坏相等元素相对顺序）。 */
export function sortTaskOverview(items) {
  const decorated = items.map((item, index) => ({ item, index }));
  decorated.sort((a, b) => {
    const orderDiff =
      (ACTION_RIGHT_ORDER[a.item.actionRight] ?? 99) -
      (ACTION_RIGHT_ORDER[b.item.actionRight] ?? 99);
    if (orderDiff !== 0) return orderDiff;
    const timeDiff = Date.parse(b.item.lastActiveAt ?? '') - Date.parse(a.item.lastActiveAt ?? '');
    if (Number.isFinite(timeDiff) && timeDiff !== 0) return timeDiff;
    return a.index - b.index;
  });
  return decorated.map((entry) => entry.item);
}

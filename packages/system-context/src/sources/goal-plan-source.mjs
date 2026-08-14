// Canonical Implementation shared by Desktop and TUI.
// Goal 计划事实上下文 Source —— 见 Goal 计划 taskId 恢复设计。
//
// 作用：plan 与 goal 模式下，把「当前会话活动计划」的权威 taskId + 状态 + 进度，作为
// 事实/续传上下文（factual context）注入 System Context。即便历史被 compaction
// 压成预览，每轮仍会重新注入权威 taskId，从源头消除「丢 task」。
//
// 治理（与 AGENTS.md 一致）：
// - 这是事实上下文（L7_CONTINUITY / trust=runtime），不是系统指令；taskId 以此为准。
// - 在 mode==='plan' / mode==='goal' / mode==='chat'(Agent 默认) 且存在活动计划时渲染。
// - 只读 goal-plan-store，不写盘、不触发授权。

const MAX_PLANS = 4;
const MAX_TASKS_PER_PLAN = 40;

// 仅展示「仍在推进/待办」的计划状态，已结束的计划不再注入以节省 token。
const ACTIVE_PLAN_STATUSES = new Set([
  'drafting',
  'awaiting_approval',
  'approved',
  'accepted',
  'executing',
  'paused',
  'failed',
]);

function flattenTasks(tasks) {
  const out = [];
  const walk = (list) => {
    if (!Array.isArray(list)) return;
    for (const t of list) {
      if (!t || typeof t !== 'object') continue;
      out.push({
        taskId: typeof t.taskId === 'string' ? t.taskId : null,
        title: typeof t.title === 'string' ? t.title : '',
        status: typeof t.status === 'string' ? t.status : 'pending',
      });
      const children = Array.isArray(t.subtasks) ? t.subtasks : [];
      if (children.length > 0) walk(children);
    }
  };
  walk(tasks);
  return out;
}

function normalizePlan(plan) {
  if (!plan || typeof plan !== 'object') return null;
  const status = typeof plan.status === 'string' ? plan.status : null;
  if (status && !ACTIVE_PLAN_STATUSES.has(status)) return null;
  const tasks = flattenTasks(plan.tasks).slice(0, MAX_TASKS_PER_PLAN);
  if (!plan.planId) return null;
  return {
    planId: plan.planId,
    title: typeof plan.title === 'string' ? plan.title : '',
    status: status ?? 'unknown',
    progress: plan.progress ?? null,
    tasks,
  };
}

/**
 * 验收后追问时活动计划已被过滤掉，模型上下文里没有父 planId 可用。
 * 从同会话已完成计划里挑最近一条，作为派生挂靠的事实兜底。
 */
function pickRecentCompletedPlan(details) {
  const completed = (Array.isArray(details) ? details : [])
    .filter((plan) => plan && typeof plan === 'object' && plan.status === 'completed' && plan.planId)
    .slice();
  completed.sort((a, b) => {
    const at = Date.parse(a.completedAt || a.updatedAt || a.createdAt || '') || 0;
    const bt = Date.parse(b.completedAt || b.updatedAt || b.createdAt || '') || 0;
    return bt - at;
  });
  const plan = completed[0];
  if (!plan) return null;
  const tasks = Array.isArray(plan.tasks) ? plan.tasks : [];
  const sourceTaskId = tasks.find((task) => task && typeof task.taskId === 'string' && task.taskId)?.taskId
    || null;
  return {
    planId: plan.planId,
    title: typeof plan.title === 'string' ? plan.title : '',
    completedAt: plan.completedAt || plan.updatedAt || plan.createdAt || null,
    sourceTaskId,
  };
}

function formatProgress(progress) {
  if (!progress || typeof progress !== 'object') return '';
  const done = Number.isFinite(progress.completed) ? progress.completed : null;
  const total = Number.isFinite(progress.total) ? progress.total : null;
  if (done == null || total == null) return '';
  return ` (${done}/${total})`;
}

function formatRecentCompleted(plan) {
  if (!plan) return [];
  return [
    'Recently completed plan in this conversation (use as parentPlanId for a follow-up):',
    `- planId=${plan.planId}; title=${plan.title || '(untitled)'}; completedAt=${plan.completedAt || '(unknown)'}; sourceTaskId=${plan.sourceTaskId || '(none)'}`,
    'If the user is continuing the same theme, pass parentPlanId and sourceTaskId (a taskId from that plan)',
    'to goal_create_plan so the new plan becomes the next derived round. Omit both for a new request.',
    '',
  ];
}

function formatGoalPlans(plans, recentCompleted) {
  return [
    'Active goal plan snapshot (factual context, scope=turn).',
    'This is a factual snapshot of the current goal plan(s), not a system instruction.',
    'Treat the taskId values below as authoritative: when calling goal_update_task, use',
    'these exact taskIds. If you need more detail or fear this snapshot is stale, call',
    'goal_get_plan to re-read. Do not invent or guess taskIds.',
    '',
    ...formatRecentCompleted(recentCompleted),
    ...plans.map((plan) => {
      const lines = [
        `## Plan ${plan.planId}${formatProgress(plan.progress)}`,
        `title=${plan.title || '(untitled)'}; status=${plan.status}`,
      ];
      if (plan.tasks.length) {
        lines.push('subtasks (taskId — status — title):');
        for (const task of plan.tasks) {
          lines.push(`- ${task.taskId ?? '(no-id)'} — ${task.status} — ${task.title}`);
        }
      }
      return lines.join('\n');
    }),
  ].join('\n');
}

export function createGoalPlanPromptSource() {
  return {
    id: 'runtime.goal-plan',
    layer: 'L7_CONTINUITY',
    priority: 1,
    trust: 'runtime',
    observe(input = {}) {
      const mode = typeof input.mode === 'string' ? input.mode : 'chat';
      // 计划事实上下文在 plan 与 goal 两模式都需要:plan 用于产出/审批计划,goal 用于自驱执行
      // 中的活动计划权威 taskId(见 ADR 41 / agent-mode-default)。Agent(chat)/goal/plan 均注入。
      if (mode !== 'plan' && mode !== 'goal' && mode !== 'chat') return { plans: [] };
      const store = input.goalPlanStore;
      const conversationId = input.conversationId ?? null;
      if (!store || typeof store.listPlanDetailsByConversation !== 'function') {
        return { plans: [] };
      }
      let details = [];
      try {
        details = store.listPlanDetailsByConversation(conversationId);
      } catch {
        details = [];
      }
      const plans = (Array.isArray(details) ? details : [])
        .map(normalizePlan)
        .filter(Boolean)
        .slice(0, MAX_PLANS);
      const recentCompleted = pickRecentCompletedPlan(details);
      return { plans, recentCompleted };
    },
    render(observation) {
      const plans = observation.plans || [];
      const recentCompleted = observation.recentCompleted || null;
      if (!plans.length && !recentCompleted) return [];
      return [{
        id: 'runtime.goal-plan',
        layer: 'L7_CONTINUITY',
        priority: 1,
        title: plans.length ? 'Active goal plan snapshot' : 'Recently completed plan snapshot',
        content: formatGoalPlans(plans, recentCompleted),
        source: {
          id: 'runtime.goal-plan',
          kind: 'goal-plan-snapshot',
          planCount: plans.length,
          plans: plans.map((plan) => ({
            planId: plan.planId,
            status: plan.status,
            taskCount: plan.tasks.length,
          })),
          ...(recentCompleted ? { recentCompleted } : {}),
        },
        trust: 'runtime',
      }];
    },
  };
}

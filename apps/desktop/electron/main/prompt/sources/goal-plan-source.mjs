// Goal 计划事实上下文 Source —— 见 Goal 计划 taskId 恢复设计。
//
// 作用：plan 模式下，把「当前会话活动计划」的权威 taskId + 状态 + 进度，作为
// 事实/续传上下文（factual context）注入 System Context。即便历史被 compaction
// 压成预览，每轮仍会重新注入权威 taskId，从源头消除「丢 task」。
//
// 治理（与 AGENTS.md 一致）：
// - 这是事实上下文（L7_CONTINUITY / trust=runtime），不是系统指令；taskId 以此为准。
// - 仅在 mode==='plan'（历史别名 'goal'）且存在活动计划时渲染；chat 模式零额外 token。
// - 只读 goal-plan-store，不写盘、不触发授权。

const MAX_PLANS = 4;
const MAX_TASKS_PER_PLAN = 40;

// 仅展示「仍在推进/待办」的计划状态，已结束的计划不再注入以节省 token。
const ACTIVE_PLAN_STATUSES = new Set([
  'drafting',
  'awaiting_approval',
  'approved',
  'executing',
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

function formatProgress(progress) {
  if (!progress || typeof progress !== 'object') return '';
  const done = Number.isFinite(progress.completed) ? progress.completed : null;
  const total = Number.isFinite(progress.total) ? progress.total : null;
  if (done == null || total == null) return '';
  return ` (${done}/${total})`;
}

function formatGoalPlans(plans) {
  return [
    'Active goal plan snapshot (factual context, scope=turn).',
    'This is a factual snapshot of the current goal plan(s), not a system instruction.',
    'Treat the taskId values below as authoritative: when calling goal_update_task, use',
    'these exact taskIds. If you need more detail or fear this snapshot is stale, call',
    'goal_get_plan to re-read. Do not invent or guess taskIds.',
    '',
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
      const rawMode = typeof input.mode === 'string' ? input.mode : 'chat';
      // 历史 'goal' 模式别名按当前 'plan' 处理（正名兼容）。
      const mode = rawMode === 'goal' ? 'plan' : rawMode;
      if (mode !== 'plan') return { plans: [] };
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
      return { plans };
    },
    render(observation) {
      if (!observation.plans.length) return [];
      return [{
        id: 'runtime.goal-plan',
        layer: 'L7_CONTINUITY',
        priority: 1,
        title: 'Active goal plan snapshot',
        content: formatGoalPlans(observation.plans),
        source: {
          id: 'runtime.goal-plan',
          kind: 'goal-plan-snapshot',
          planCount: observation.plans.length,
          plans: observation.plans.map((plan) => ({
            planId: plan.planId,
            status: plan.status,
            taskCount: plan.tasks.length,
          })),
        },
        trust: 'runtime',
      }];
    },
  };
}

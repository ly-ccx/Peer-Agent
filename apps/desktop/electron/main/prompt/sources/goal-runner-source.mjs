// Goal Runner 上下文 Source —— 见 docs/design/goal-runner-explorer-task-list.md Slice 5。
//
// 作用：goal 模式下，Runner 托管推进 turn 通过明确的 Context Source 注入「续推上下文」，
// 而不是把目标/边界/预算等实质内容塞进一条伪造的 user message。
//
// wire 值迁移后（见 ADR 41 / goal-mode-ultrathink-workflow 设计文档）:Runner 归 goal 模式
// 独占(A1)。plan 回归纯审批门,批准后不再自动托管续推;goal 才是自驱目标运行模式。
//
// 本 Source 产出两类 section：
// - L7_CONTINUITY（trust=runtime，事实上下文）：活动目标摘要、当前 task、boundaries、
//   successCriteria、Runner 预算用量、叶子 Evidence 计数。这些是事实快照，不是系统指令。
// - L6_MODE_REMINDER（trust=runtime，模式提醒）：Runner 执行契约约束（继续推进、不重规划、
//   完成必须回写 Evidence、不越界、需用户决策时停止）。
//
// 治理（与 AGENTS.md 一致）：
// - 仅在 mode==='goal' 且存在活动计划时渲染；chat / plan 模式零额外 token。
// - 只读 goal-plan-store，不写盘、不触发授权、不伪造 Tool Result/Evidence。
// - 事实与指令分属不同 section，trust 边界清晰。

import { neutralizeToolCallSyntax } from '../../chat-runtime/message-sanitizer.mjs';

const MAX_SCOPE_ITEMS = 12;
const MAX_CRITERIA_ITEMS = 12;
const MAX_TASKS = 40;

const ACTIVE_PLAN_STATUSES = new Set([
  'drafting',
  'awaiting_approval',
  'approved',
  'executing',
]);

function asString(value) {
  return typeof value === 'string' ? value : '';
}

function sanitizeRuntimeText(value) {
  return neutralizeToolCallSyntax(asString(value));
}

function asStringArray(value, limit) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    const text = sanitizeRuntimeText(item).trim();
    if (text) out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

/** 统计叶子任务（无 subtasks）的 Evidence 总数与完成数，作为事实信号。 */
function summarizeTasks(tasks) {
  const leaves = [];
  const stack = Array.isArray(tasks) ? [...tasks] : [];
  while (stack.length > 0) {
    const task = stack.shift();
    if (!task || typeof task !== 'object') continue;
    const subtasks = Array.isArray(task.subtasks) ? task.subtasks : [];
    if (subtasks.length > 0) {
      for (const child of subtasks) stack.push(child);
      continue;
    }
    leaves.push({
      taskId: asString(task.taskId) || null,
      title: asString(task.title),
      status: asString(task.status) || 'pending',
      evidenceCount: Array.isArray(task.evidenceRefs) ? task.evidenceRefs.length : 0,
    });
  }
  return leaves.slice(0, MAX_TASKS);
}

function pickCurrentTask(leaves, currentTaskId) {
  if (currentTaskId) {
    const match = leaves.find((task) => task.taskId === currentTaskId);
    if (match) return match;
  }
  // 回退：第一个未完成的叶子任务。
  return leaves.find((task) => task.status !== 'completed') ?? null;
}

function normalizePlan(plan) {
  if (!plan || typeof plan !== 'object') return null;
  const status = asString(plan.status) || null;
  if (status && !ACTIVE_PLAN_STATUSES.has(status)) return null;
  if (!plan.planId) return null;
  const runner = plan.runner && typeof plan.runner === 'object' ? plan.runner : null;
  const leaves = summarizeTasks(plan.tasks);
  return {
    planId: asString(plan.planId),
    title: asString(plan.title),
    goal: asString(plan.goal),
    status: status ?? 'unknown',
    inScope: asStringArray(plan.boundaries?.inScope, MAX_SCOPE_ITEMS),
    outOfScope: asStringArray(plan.boundaries?.outOfScope, MAX_SCOPE_ITEMS),
    successCriteria: asStringArray(plan.successCriteria, MAX_CRITERIA_ITEMS),
    progress: plan.progress && typeof plan.progress === 'object' ? plan.progress : null,
    leaves,
    currentTask: pickCurrentTask(leaves, asString(runner?.currentTaskId) || null),
    budget: runner
      ? {
          turnCount: Number.isFinite(runner.turnCount) ? runner.turnCount : 0,
          maxTurns: Number.isFinite(runner.maxTurns) ? runner.maxTurns : null,
          toolCallCount: Number.isFinite(runner.toolCallCount) ? runner.toolCallCount : 0,
          maxToolCalls: Number.isFinite(runner.maxToolCalls) ? runner.maxToolCalls : null,
          explorerCount: Number.isFinite(runner.explorerCount) ? runner.explorerCount : 0,
          maxExplorers: Number.isFinite(runner.maxExplorers) ? runner.maxExplorers : null,
        }
      : null,
  };
}

function formatBudget(budget) {
  if (!budget) return '(not started)';
  const parts = [
    `turns ${budget.turnCount}${budget.maxTurns != null ? `/${budget.maxTurns}` : ''}`,
    `toolCalls ${budget.toolCallCount}${budget.maxToolCalls != null ? `/${budget.maxToolCalls}` : ''}`,
    `explorers ${budget.explorerCount}${budget.maxExplorers != null ? `/${budget.maxExplorers}` : ''}`,
  ];
  return parts.join('; ');
}

function formatFacts(plan) {
  const lines = [
    'Active goal runner context (factual context, scope=turn).',
    'This is a factual snapshot of the goal the runner is advancing, not a system instruction.',
    'If you fear this snapshot is stale, call goal_get_plan to re-read authoritative state.',
    '',
    `Plan ${plan.planId} — status=${plan.status}`,
  ];
  const title = sanitizeRuntimeText(plan.title);
  const goal = sanitizeRuntimeText(plan.goal);
  if (title) lines.push(`title=${title}`);
  if (goal) lines.push(`goal=${goal}`);
  if (plan.currentTask) {
    const t = plan.currentTask;
    lines.push(
      `current task: ${t.taskId ?? '(no-id)'} — ${t.status} — ${sanitizeRuntimeText(t.title) || '(untitled)'} (evidenceRefs=${t.evidenceCount})`,
    );
  }
  if (plan.inScope.length) {
    lines.push('in scope:');
    for (const item of plan.inScope) lines.push(`- ${item}`);
  }
  if (plan.outOfScope.length) {
    lines.push('out of scope:');
    for (const item of plan.outOfScope) lines.push(`- ${item}`);
  }
  if (plan.successCriteria.length) {
    lines.push('success criteria:');
    for (const item of plan.successCriteria) lines.push(`- ${item}`);
  }
  lines.push(`runner budget: ${formatBudget(plan.budget)}`);
  return lines.join('\n');
}

function formatContract() {
  return [
    'Goal Runner execution contract:',
    '- Continue advancing the current goal; do not re-plan unrelated goals.',
    '- When uncertain, prefer reading authoritative state via goal_get_plan.',
    '- After completing a subtask, write evidence back through goal_update_task; do not mark completion without evidenceRefs.',
    '- Do not cross the declared boundaries.',
    '- If you need user input, permission, or evidence is insufficient, call request_user_input (or stop) and explain the blocker instead of pretending completion.',
    '- Do not use request_user_input to re-ask for plan approval once a plan is awaiting approval; that binary approve/reject decision is owned by the governed approval card / Goal panel (goalPlansApprove). Reserve request_user_input for substantive follow-ups only.',
    '- Use the existing tools and permission flow; do not fabricate Tool Result or Evidence.',
  ].join('\n');
}

export function createGoalRunnerPromptSource() {
  return {
    id: 'runtime.goal-runner',
    layer: 'L6_MODE_REMINDER',
    priority: 1,
    trust: 'runtime',
    observe(input = {}) {
      const mode = asString(input.mode) || 'chat';
      // Runner 归 goal 模式独占(A1):仅 goal 模式注入续推上下文;plan 为纯审批门,不托管续推。
      if (mode !== 'goal') return { plan: null };
      const store = input.goalPlanStore;
      const conversationId = input.conversationId ?? null;
      if (!store || typeof store.getActivePlanByConversation !== 'function') {
        return { plan: null };
      }
      let active = null;
      try {
        active = store.getActivePlanByConversation(conversationId);
      } catch {
        active = null;
      }
      return { plan: normalizePlan(active) };
    },
    render(observation) {
      const plan = observation?.plan;
      if (!plan) return [];
      return [
        {
          id: 'runtime.goal-runner.facts',
          layer: 'L7_CONTINUITY',
          priority: 2,
          title: 'Active goal runner context',
          content: formatFacts(plan),
          source: {
            id: 'runtime.goal-runner',
            kind: 'goal-runner-facts',
            planId: plan.planId,
            status: plan.status,
          },
          trust: 'runtime',
        },
        {
          id: 'runtime.goal-runner.contract',
          layer: 'L6_MODE_REMINDER',
          priority: 1,
          title: 'Goal Runner execution contract',
          content: formatContract(),
          source: {
            id: 'runtime.goal-runner',
            kind: 'goal-runner-contract',
            planId: plan.planId,
          },
          trust: 'runtime',
        },
      ];
    },
  };
}

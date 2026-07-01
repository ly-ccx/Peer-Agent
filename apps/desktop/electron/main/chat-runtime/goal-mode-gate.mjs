/**
 * Plan 模式运行时闸门 —— 见 Plan 模式设计。
 *
 * 设计要点（与 AGENTS.md 非协商运行时链一致）：
 * - 闸门是 PermissionGrant 之前的「能力准入」判定，跑在 projected-tool 执行入口，
 *   不新增旁路执行路径，也不依赖 prompt 作为唯一执行手段。
 * - plan 模式「先规划 → 批准 → 执行」：计划未获批准前，只放行规划 / 回写 / 提问 / 惰性只读
 *   能力；一切有副作用的能力（写文件、shell、MCP 副作用）被结构化拒绝。
 * - 计划状态是「活事实」，从 goal-plan-store 按 conversationId 实时读取，避免用流开始时的
 *   静态快照（模型可能在回合中途才 goal_create_plan）。
 */

import { createGoalPlanStore } from '../goal-plan-store.mjs';

// Plan 模式下「无论计划是否获批」始终放行的工具（规划 / 回写 / 只读读回 / 向用户提问）。
const PLAN_ALWAYS_ALLOWED_TOOLS = Object.freeze(
  new Set(['goal_create_plan', 'goal_update_task', 'goal_get_plan', 'request_user_input']),
);

// 视为「无副作用」的风险等级：未获批准时也放行（只读 / 惰性）。
const INERT_RISK_LEVELS = Object.freeze(new Set(['L0_inert', 'L1_local_read']));

// 视为「计划已就绪、可执行」的计划状态。
const EXECUTABLE_PLAN_STATUSES = Object.freeze(new Set(['approved', 'executing', 'completed']));

let sharedGoalPlanStore = null;
function defaultGoalPlanStore() {
  if (!sharedGoalPlanStore) sharedGoalPlanStore = createGoalPlanStore();
  return sharedGoalPlanStore;
}

/**
 * 读取某会话的「计划闸门事实」：是否存在计划、是否有已就绪（获批/执行中）的计划。
 */
export function resolveGoalPlanGate(conversationId, goalPlanStore = defaultGoalPlanStore()) {
  if (!conversationId || typeof goalPlanStore?.listPlansByConversation !== 'function') {
    return { hasPlan: false, hasApprovedPlan: false };
  }
  let plans = [];
  try {
    plans = goalPlanStore.listPlansByConversation(conversationId) ?? [];
  } catch {
    plans = [];
  }
  const hasPlan = plans.length > 0;
  const hasApprovedPlan = plans.some((plan) => EXECUTABLE_PLAN_STATUSES.has(plan?.status));
  return { hasPlan, hasApprovedPlan };
}

/**
 * 纯函数：在给定 mode / 工具 / 风险等级 / 计划闸门事实下，决定是否放行。
 * 返回 { allowed: true } 或 { allowed: false, reason }。
 */
export function evaluateGoalModeGate({
  mode = 'chat',
  toolName,
  riskLevel = 'L2_local_write',
  planGate = { hasPlan: false, hasApprovedPlan: false },
} = {}) {
  // wire 值迁移后（见 ADR 41 / goal-mode-ultrathink-workflow 设计文档十一章）:
  // - plan 模式:审批门。计划获批前拒绝一切有副作用能力(下方逻辑)。
  // - goal 模式:自驱目标模式,不施加「计划审批门」。Runner 托管 explore→plan→act→verify
  //   闭环、默认推进、最小打扰;高风险/不可逆动作由后续 hooks(on-irreversible)逐动作确认,
  //   而非整模式审批。故 goal 模式在本闸门直接放行。
  // - 其余模式(chat 等)不施加任何额外闸门。
  if (mode !== 'plan') return { allowed: true };

  // 规划 / 回写 / 提问：始终放行（这正是产出计划与求批准的手段）。
  if (PLAN_ALWAYS_ALLOWED_TOOLS.has(toolName)) return { allowed: true };

  // 计划已就绪：按既有权限链继续，闸门放行。
  if (planGate?.hasApprovedPlan) return { allowed: true };

  // 计划未就绪：只读 / 惰性能力放行（调研、检索不产生副作用）。
  if (INERT_RISK_LEVELS.has(riskLevel)) return { allowed: true };

  // 其余（有副作用）能力：拒绝，要求先产出计划并获批准。
  return {
    allowed: false,
    reason: planGate?.hasPlan ? 'goal_plan_not_approved' : 'goal_plan_required',
  };
}

function denialMessage(reason, locale) {
  const zh = locale !== 'en-US';
  if (reason === 'goal_plan_not_approved') {
    return zh
      ? 'Plan 模式：已有计划但尚未获批准。请通过右侧计划面板/批准卡取得用户批准，获批后再执行有副作用的操作。'
      : 'Plan mode: a plan exists but is not approved yet. Get user approval via the Plan panel/approval card before running side-effecting actions.';
  }
  return zh
    ? 'Plan 模式：必须先用 goal_create_plan 产出目标与完整计划，并经用户批准，才能执行有副作用的操作。'
    : 'Plan mode: you must first produce a goal and full plan via goal_create_plan and get user approval before running side-effecting actions.';
}

/**
 * 把闸门拒绝转成一次「结构化失败的工具执行结果」，复用既有 denial/Evidence 表达，
 * 不绕过 Runtime Projection，也不伪装成功。
 */
export function buildGoalModeDenial({ name, reason, locale = 'zh-CN' }) {
  return {
    success: false,
    error: denialMessage(reason, locale),
    output: JSON.stringify({
      kind: 'goal_mode_gate_denied',
      tool: name,
      reason,
      message: denialMessage(reason, locale),
    }),
    goalModeDenied: true,
  };
}

/**
 * Goal-plan relation derivation shared by Desktop and TUI.
 *
 * 验收后追问时，模型可能漏填关系字段。同会话有最近完成计划、且文案不像明确新需求时，
 * 自动补 parentPlanId + 父计划上真实存在的 sourceTaskId。
 * 显式传入的字段优先；只补缺失的那一侧，避免覆盖模型选择。
 *
 * 该逻辑必须由所有 surface 共用：关系字段是 goal-plan-store 的硬约束
 * （parentPlanId / sourceTaskId 必须成对且 sourceTaskId 真实存在于父计划），
 * 两端各写一份实现必然漂移。
 */

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

const EXPLICIT_NEW_REQUEST_RE = /(?:新需求|新任务|新目标|另开|另外做|换个|无关|unrelated|new request|new goal|separate task|different topic)/i;

export function looksLikeExplicitNewRequest(text) {
  return EXPLICIT_NEW_REQUEST_RE.test(String(text || ''));
}

function pickSourceTaskId(plan) {
  const tasks = Array.isArray(plan?.tasks) ? plan.tasks : [];
  const match = tasks.find((task) => task && typeof task.taskId === 'string' && task.taskId.trim());
  return match ? match.taskId.trim() : null;
}

/** 从会话计划详情里挑最近完成的一个（作为追问的默认父计划）。 */
export function pickRecentCompletedPlan(details) {
  const completed = (Array.isArray(details) ? details : [])
    .filter((plan) => plan && typeof plan === 'object' && plan.status === 'completed' && plan.planId)
    .slice();
  completed.sort((a, b) => {
    const at = Date.parse(a.completedAt || a.updatedAt || a.createdAt || '') || 0;
    const bt = Date.parse(b.completedAt || b.updatedAt || b.createdAt || '') || 0;
    return bt - at;
  });
  return completed[0] || null;
}

export function resolveDerivedPlanRelation({
  parentPlanId,
  sourceTaskId,
  title,
  goal,
  recentCompleted,
} = {}) {
  const explicitParent = nonEmptyString(parentPlanId);
  const explicitSource = nonEmptyString(sourceTaskId);
  if (explicitParent && explicitSource) {
    return { parentPlanId: explicitParent, sourceTaskId: explicitSource, attached: false };
  }
  if (looksLikeExplicitNewRequest(`${title || ''} ${goal || ''}`)) {
    return {
      ...(explicitParent ? { parentPlanId: explicitParent } : {}),
      ...(explicitSource ? { sourceTaskId: explicitSource } : {}),
      attached: false,
    };
  }
  const parentId = explicitParent || nonEmptyString(recentCompleted?.planId);
  const sourceId = explicitSource || pickSourceTaskId(recentCompleted);
  if (!parentId || !sourceId) {
    return {
      ...(explicitParent ? { parentPlanId: explicitParent } : {}),
      ...(explicitSource ? { sourceTaskId: explicitSource } : {}),
      attached: false,
    };
  }
  return { parentPlanId: parentId, sourceTaskId: sourceId, attached: !explicitParent || !explicitSource };
}

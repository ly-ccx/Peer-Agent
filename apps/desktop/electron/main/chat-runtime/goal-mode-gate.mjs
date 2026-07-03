/**
 * Plan / Goal 模式运行时闸门 —— 见 Plan 模式设计 与 goal-mode-ultrathink-workflow 设计文档。
 *
 * 设计要点（与 AGENTS.md 非协商运行时链一致）：
 * - 闸门是 PermissionGrant 之前的「能力准入」判定，跑在 projected-tool 执行入口，
 *   不新增旁路执行路径，也不依赖 prompt 作为唯一执行手段。
 * - plan 模式「先规划 → 批准 → 执行」：计划未获批准前，只放行规划 / 回写 / 提问 / 惰性只读
 *   能力；一切有副作用的能力（写文件、shell、MCP 副作用）被结构化拒绝。
 * - goal 模式「自驱目标模式」：不施加整模式「计划审批门」，改用确定性 hooks·阶段一——
 *   ①pre-act 写盘范围守卫（越出 workspace 或命中 outOfScope 即 DENY）；
 *   ②on-irreversible 不可逆动作（删除/覆盖/git 强制/push/release）逐动作确认。
 * - 计划状态 / 边界是「活事实」，从 goal-plan-store 按 conversationId 实时读取，避免用流开始时的
 *   静态快照（模型可能在回合中途才 goal_create_plan）。
 */

import path from 'node:path';
import { createGoalPlanStore } from '../goal-plan-store.mjs';

// Plan 模式下「无论计划是否获批」始终放行的工具（规划 / 回写 / 只读读回 / 向用户提问）。
const PLAN_ALWAYS_ALLOWED_TOOLS = Object.freeze(
  new Set(['goal_create_plan', 'goal_update_task', 'goal_get_plan', 'request_user_input']),
);

// 视为「无副作用」的风险等级：未获批准时也放行（只读 / 惰性）。
const INERT_RISK_LEVELS = Object.freeze(new Set(['L0_inert', 'L1_local_read']));

// 视为「计划已就绪、可执行」的计划状态。
const EXECUTABLE_PLAN_STATUSES = Object.freeze(new Set(['approved', 'executing', 'completed']));

// ── goal 模式确定性 hooks·阶段一（见设计文档第七章）：只硬编码两条规则，不建通用框架。 ──

// 带「目标路径」的写工具 → 参与 pre-act 写盘范围守卫。
const PATH_WRITE_TOOLS = Object.freeze(new Set(['write_file', 'edit_file']));

// 转义正则元字符（用函数替换器，避免 '$&' 之类替换特殊记号被上游误展开）。
function escapeRegExp(literal) {
  return literal.replace(/[.+^${}()|[\]\\]/g, (m) => '\\' + m);
}

// 判定 targetPath 是否落在 workspaceRoot 内（含 root 本身）。纯路径判定，不触碰磁盘。
function isInsideWorkspace(targetPath, workspaceRoot) {
  if (!targetPath || !workspaceRoot) return true; // 缺信息时不阻断，交后续 permission 网关裁决。
  const abs = path.isAbsolute(targetPath)
    ? path.normalize(targetPath)
    : path.resolve(workspaceRoot, targetPath);
  const root = path.resolve(workspaceRoot);
  const rel = path.relative(root, abs);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// outOfScope 模式匹配：仅对「像路径/glob」的条目做匹配（含 / . * 之一）；
// 纯描述性文字（如「不改审批语义」）不参与路径匹配，避免误伤。
function matchesScopePattern(targetPath, pattern) {
  if (typeof pattern !== 'string' || !pattern.trim()) return false;
  const p = pattern.trim();
  // 「像路径/glob」判定：含 / 或 *；以 .ext 结尾；或是单个 word-like token（纯 ASCII 词字符 + . - ，无空格）。
  // 纯描述性文字（含空格 / CJK 等，如「不改审批语义」「do not touch chat mode」）不参与路径匹配，避免误伤。
  const looksPathLike =
    p.includes('/') || p.includes('*') || /\.[a-z0-9]+$/i.test(p) || /^[\w.-]+$/.test(p);
  if (!looksPathLike) return false;
  const norm = String(targetPath).replace(/\\/g, '/');
  if (p.includes('*')) {
    // glob → regex：** 匹配任意（含分隔符），* 匹配任意非分隔字符。
    const body = escapeRegExp(p)
      .replace(/\\\*\\\*/g, '\u0000')
      .replace(/\\\*/g, '[^/]*')
      .replace(/\u0000/g, '.*');
    const re = new RegExp('^' + body + '$');
    if (re.test(norm)) return true;
    // 目录前缀 glob（如 dist/*）也命中其下任意文件。
    const base = p.replace(/\/?\*+.*$/, '');
    return base.length > 0 && (norm === base || norm.startsWith(base + '/') || norm.includes('/' + base + '/'));
  }
  // 非 glob 的路径片段：按路径段包含匹配。
  const seg = p.replace(/\/+$/, '');
  return norm === seg || norm.endsWith('/' + seg) || norm.includes('/' + seg + '/') || norm.startsWith(seg + '/');
}

// pre-act 写盘范围守卫：目标路径越出 workspace 或命中 outOfScope → 拒绝。
export function evaluateWriteScope({ args, workspacePath, boundaries } = {}) {
  const targetPath = typeof args?.path === 'string' ? args.path : null;
  if (!targetPath) return { allowed: true }; // 无路径信息，保守放行。
  if (workspacePath && !isInsideWorkspace(targetPath, workspacePath)) {
    return { allowed: false, reason: 'goal_scope_out_of_workspace', detail: targetPath };
  }
  const outOfScope = Array.isArray(boundaries?.outOfScope) ? boundaries.outOfScope : [];
  for (const pat of outOfScope) {
    if (matchesScopePattern(targetPath, pat)) {
      return { allowed: false, reason: 'goal_scope_out_of_bounds', detail: targetPath + ' ∈ outOfScope(' + pat + ')' };
    }
  }
  return { allowed: true };
}

// on-irreversible：不可逆动作启发式识别（删除 / 覆盖 / git 强制 / push / release）。
const IRREVERSIBLE_BASH_PATTERNS = Object.freeze([
  { re: /\brm\s+-[a-z]*\b/i, kind: 'shell_delete' },
  { re: /\bgit\s+push\b/i, kind: 'git_push' },
  { re: /\bgit\b[^\n]*?\s(?:--force|-f)\b/i, kind: 'git_force' },
  { re: /\bgit\s+reset\s+--hard\b/i, kind: 'git_reset_hard' },
  { re: /\bgit\s+clean\b/i, kind: 'git_clean' },
  { re: /\b(?:npm|yarn|pnpm|tnpm)\s+publish\b/i, kind: 'release_publish' },
  { re: /\bgit\s+tag\b/i, kind: 'git_tag' },
]);

// 返回命中的不可逆动作元信息（{ kind, detail }），未命中返回 null。
export function detectIrreversibleAction({ toolName, args } = {}) {
  if (toolName === 'write_file' && args?.allow_overwrite === true) {
    return { kind: 'file_overwrite', detail: typeof args?.path === 'string' ? args.path : '' };
  }
  if (toolName === 'bash') {
    const cmd = String(args?.command ?? '');
    for (const p of IRREVERSIBLE_BASH_PATTERNS) {
      if (p.re.test(cmd)) return { kind: p.kind, detail: cmd };
    }
  }
  return null;
}

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
 * 读取某会话活跃计划的 boundaries（供 goal 模式写盘范围守卫使用）。
 */
export function resolveActivePlanBoundaries(conversationId, goalPlanStore = defaultGoalPlanStore()) {
  if (!conversationId || typeof goalPlanStore?.getActivePlanByConversation !== 'function') {
    return null;
  }
  try {
    const plan = goalPlanStore.getActivePlanByConversation(conversationId);
    return plan?.boundaries ?? null;
  } catch {
    return null;
  }
}

/**
 * 纯函数：在给定 mode / 工具 / 风险等级 / 计划闸门事实 / 参数与边界下，决定是否放行。
 * 返回：
 * - { allowed: true }
 * - { allowed: true, requiresConfirmation: true, confirmation: { kind, detail } }（goal 模式不可逆动作）
 * - { allowed: false, reason }（plan 未获批 或 goal 写盘越界）
 */
export function evaluateGoalModeGate({
  mode = 'chat',
  toolName,
  riskLevel = 'L2_local_write',
  planGate = { hasPlan: false, hasApprovedPlan: false },
  args = null,
  workspacePath = null,
  boundaries = null,
} = {}) {
  // wire 值迁移后（见 ADR 41 / goal-mode-ultrathink-workflow 设计文档十一章）：
  // - plan 模式：审批门。计划获批前拒绝一切有副作用能力（下方逻辑）。
  // - goal 模式：自驱目标模式，不施加整模式「计划审批门」，改用确定性 hooks·阶段一。
  // - 其余模式（chat 等）不施加任何额外闸门。
  if (mode === 'goal') {
    // 规划 / 回写 / 提问：始终放行。
    if (PLAN_ALWAYS_ALLOWED_TOOLS.has(toolName)) return { allowed: true };
    // 惰性 / 只读能力：直接放行。
    if (INERT_RISK_LEVELS.has(riskLevel)) return { allowed: true };
    // ① pre-act 写盘范围守卫（write_file / edit_file）。
    if (PATH_WRITE_TOOLS.has(toolName)) {
      const scope = evaluateWriteScope({ args, workspacePath, boundaries });
      if (!scope.allowed) return { allowed: false, reason: scope.reason, detail: scope.detail };
    }
    // ② on-irreversible 不可逆动作 → 放行但要求逐动作确认。
    const irreversible = detectIrreversibleAction({ toolName, args });
    if (irreversible) {
      return { allowed: true, requiresConfirmation: true, confirmation: irreversible };
    }
    return { allowed: true };
  }

  if (mode !== 'plan') return { allowed: true };

  // 规划 / 回写 / 提问：始终放行（这正是产出计划与求批准的手段）。
  if (PLAN_ALWAYS_ALLOWED_TOOLS.has(toolName)) return { allowed: true };

  // 计划已就绪：按既有权限链继续，闸门放行。
  if (planGate?.hasApprovedPlan) return { allowed: true };

  // 惰性 / 只读能力：即使计划未获批也放行。
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
  if (reason === 'goal_scope_out_of_workspace') {
    return zh
      ? 'Goal 模式：拒绝写入 workspace 之外的路径。请把写操作限制在当前工作区内。'
      : 'Goal mode: refusing to write outside the active workspace. Keep write operations within the current workspace.';
  }
  if (reason === 'goal_scope_out_of_bounds') {
    return zh
      ? 'Goal 模式：目标路径命中目标的 out-of-scope 边界，已拒绝。如需变更范围，请更新目标边界。'
      : 'Goal mode: target path matches the goal\'s out-of-scope boundary and was denied. Update the goal boundaries to change scope.';
  }
  if (reason === 'goal_irreversible_denied') {
    return zh
      ? 'Goal 模式：不可逆动作（删除/覆盖/git 强制/push/release）未获用户确认，已拒绝执行。'
      : 'Goal mode: an irreversible action (delete/overwrite/git force/push/release) was not confirmed by the user and was denied.';
  }
  return zh
    ? 'Plan 模式：必须先用 goal_create_plan 产出目标与完整计划，并经用户批准，才能执行有副作用的操作。'
    : 'Plan mode: you must first produce a goal and full plan via goal_create_plan and get user approval before running side-effecting actions.';
}

/**
 * 把闸门拒绝转成一次「结构化失败的工具执行结果」，复用既有 denial/Evidence 表达，
 * 不绕过 Runtime Projection，也不伪装成功。
 */
export function buildGoalModeDenial({ name, reason, locale = 'zh-CN', detail = null }) {
  return {
    success: false,
    error: denialMessage(reason, locale),
    output: JSON.stringify({
      kind: 'goal_mode_gate_denied',
      tool: name,
      reason,
      detail: detail ?? undefined,
      message: denialMessage(reason, locale),
    }),
    goalModeDenied: true,
  };
}

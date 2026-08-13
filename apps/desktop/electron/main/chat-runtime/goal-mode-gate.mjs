/**
 * Plan / Goal 模式运行时闸门 —— 见 Plan 模式设计 与 goal-mode-ultrathink-workflow 设计文档。
 *
 * 设计要点（与 AGENTS.md 非协商运行时链一致）：
 * - 闸门是 PermissionGrant 之前的「能力准入」判定，跑在 projected-tool 执行入口，
 *   不新增旁路执行路径，也不依赖 prompt 作为唯一执行手段。
 * - plan 模式「先规划 → 批准 → 执行」：计划未获批准前，只放行规划 / 回写 / 提问 / 惰性只读
 *   能力；一切有副作用的能力（写文件、shell、MCP 副作用）被结构化拒绝。
 * - goal 模式「自驱目标模式」：不施加整模式「计划审批门」，改用确定性 hooks·阶段一——
 *   ①pre-act 写盘范围守卫（越出 Goal 绑定写入根或命中 outOfScope 即 DENY）；
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

const RISK_ORDER = Object.freeze({
  L0_inert: 0,
  L1_local_read: 1,
  L2_local_write: 2,
  L3_external_write: 3,
  L4_privileged: 4,
  L5_destructive: 5,
});

// 视为「计划已就绪、可执行」的计划状态。
const EXECUTABLE_PLAN_STATUSES = Object.freeze(new Set(['approved', 'executing', 'completed']));
// 终态计划状态：用于判定 intake 契约是否仍活跃（终态契约不再施加 intake 禁写闸门）。
const GATE_TERMINAL_PLAN_STATUSES = Object.freeze(new Set(['completed', 'cancelled', 'failed']));

// ── goal 模式确定性 hooks·阶段一（见设计文档第七章）：只硬编码两条规则，不建通用框架。 ──

// 带「目标路径」的写工具 → 参与 pre-act 写盘范围守卫。
const PATH_WRITE_TOOLS = Object.freeze(new Set(['write_file', 'edit_file']));

// 转义正则元字符（用函数替换器，避免 '$&' 之类替换特殊记号被上游误展开）。
function escapeRegExp(literal) {
  return literal.replace(/[.+^${}()|[\]\\]/g, (m) => '\\' + m);
}

function normalizeWorkspacePath(value) {
  return typeof value === 'string' && value.trim() ? path.resolve(value.trim()) : null;
}

function normalizeWorkspaceRoots(values) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = normalizeWorkspacePath(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function resolveTargetPath(targetPath, baseWorkspacePath) {
  if (!targetPath) return null;
  return path.isAbsolute(targetPath)
    ? path.normalize(targetPath)
    : path.resolve(baseWorkspacePath || process.cwd(), targetPath);
}

// 判定 absolutePath 是否落在 workspaceRoot 内（含 root 本身）。纯路径判定，不触碰磁盘。
function isInsideWorkspace(absolutePath, workspaceRoot) {
  if (!absolutePath || !workspaceRoot) return true; // 缺信息时不阻断，交后续 permission 网关裁决。
  const abs = path.resolve(absolutePath);
  const root = path.resolve(workspaceRoot);
  const rel = path.relative(root, abs);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function isInsideAnyWorkspace(absolutePath, workspaceRoots) {
  const roots = normalizeWorkspaceRoots(workspaceRoots);
  if (roots.length === 0) return true;
  return roots.some((root) => isInsideWorkspace(absolutePath, root));
}

function scopePathCandidates({ targetPath, absoluteTargetPath, writableRoots }) {
  const candidates = new Set();
  if (typeof targetPath === 'string' && targetPath.trim()) {
    candidates.add(targetPath.trim().replace(/\\/g, '/'));
  }
  if (absoluteTargetPath) {
    candidates.add(String(absoluteTargetPath).replace(/\\/g, '/'));
  }
  for (const root of normalizeWorkspaceRoots(writableRoots)) {
    if (!absoluteTargetPath || !isInsideWorkspace(absoluteTargetPath, root)) continue;
    const rel = path.relative(root, absoluteTargetPath);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      candidates.add(rel.replace(/\\/g, '/'));
    }
  }
  return Array.from(candidates);
}

// outOfScope 模式匹配：仅对「像路径/glob」的条目做匹配（含 / . * 之一）；
// 纯描述性文字（如「不改审批语义」）不参与路径匹配，避免误伤。
function looksPathLikeScopePattern(pattern) {
  if (typeof pattern !== 'string' || !pattern.trim()) return false;
  const p = pattern.trim();
  // 「像路径/glob」判定：含 / 或 *；以 .ext 结尾；或是单个 word-like token（纯 ASCII 词字符 + . - ，无空格）。
  // 纯描述性文字（含空格 / CJK 等，如「不改审批语义」「do not touch chat mode」）不参与路径匹配，避免误伤。
  return p.includes('/') || p.includes('*') || /\.[a-z0-9]+$/i.test(p) || /^[\w.-]+$/.test(p);
}

function matchesScopePattern(targetPath, pattern) {
  if (!looksPathLikeScopePattern(pattern)) return false;
  const p = pattern.trim();
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

// pre-act 写盘范围守卫：目标路径越出 Goal 绑定写入根或命中 outOfScope → 拒绝。
export function evaluateWriteScope({ args, workspacePath, writableRoots = null, boundaries } = {}) {
  const targetPath = typeof args?.path === 'string' ? args.path : null;
  if (!targetPath) return { allowed: true }; // 无路径信息，保守放行。
  const baseWorkspacePath = normalizeWorkspacePath(workspacePath);
  const roots = normalizeWorkspaceRoots(writableRoots && writableRoots.length > 0 ? writableRoots : [baseWorkspacePath]);
  const absoluteTargetPath = resolveTargetPath(targetPath, baseWorkspacePath || roots[0]);
  // Product decision (2026-07-21): no path hard sandbox.
  // Outside origin/target writable roots is allowed; permission gates still apply upstream.
  // Explicit outOfScope globs remain hard denies below.
  const scopeCandidates = scopePathCandidates({ targetPath, absoluteTargetPath, writableRoots: roots });
  const outOfScope = Array.isArray(boundaries?.outOfScope) ? boundaries.outOfScope : [];
  for (const pat of outOfScope) {
    if (scopeCandidates.some((candidate) => matchesScopePattern(candidate, pat))) {
      return { allowed: false, reason: 'goal_scope_out_of_bounds', detail: targetPath + ' ∈ outOfScope(' + pat + ')' };
    }
  }
  const inScope = Array.isArray(boundaries?.inScope) ? boundaries.inScope : [];
  const pathLikeInScope = inScope.filter(looksPathLikeScopePattern);
  if (
    pathLikeInScope.length > 0 &&
    !pathLikeInScope.some((pat) => scopeCandidates.some((candidate) => matchesScopePattern(candidate, pat)))
  ) {
    return {
      allowed: true,
      requiresConfirmation: true,
      reason: 'goal_scope_expansion_confirmation',
      detail: targetPath,
    };
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

function isHighRiskGoalAction(riskLevel) {
  return (RISK_ORDER[riskLevel] ?? RISK_ORDER.L2_local_write) >= RISK_ORDER.L4_privileged;
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
    return { hasPlan: false, hasApprovedPlan: false, intakeActive: false };
  }
  let plans = [];
  try {
    plans = goalPlanStore.listPlansByConversation(conversationId) ?? [];
  } catch {
    plans = [];
  }
  // 只有非终态计划能承接新的副作用。历史 completed/cancelled/failed 计划不能被后续工作
  // 借用；用户选择继续讨论时，application service 会先把同一计划重开为 executing。
  const hasPlan = plans.some((plan) => !GATE_TERMINAL_PLAN_STATUSES.has(plan?.status));
  const hasApprovedPlan = plans.some(
    (plan) =>
      !GATE_TERMINAL_PLAN_STATUSES.has(plan?.status)
      && EXECUTABLE_PLAN_STATUSES.has(plan?.status),
  );
  // intake 判别阶段事实：存在一条 activation.kind==='intake' 且仍活跃（非终态）的契约。
  // intake 阶段只做只读/问答/澄清，闸门据此拒绝一切有副作用能力（见「方案乙」write-gate）。
  const intakeActive = plans.some(
    (plan) => plan?.activation?.kind === 'intake' && !GATE_TERMINAL_PLAN_STATUSES.has(plan?.status),
  );
  return { hasPlan, hasApprovedPlan, intakeActive };
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
 * Goal 执行绑定：当前会话 workspace 是认知起点(origin)，active Goal 的 targetWorkspacePath
 * 是写入与验证目标。若没有 target，则保持旧行为：当前 workspace 即执行根。
 */
export function resolveActiveGoalExecutionBinding(
  conversationId,
  workspacePath = null,
  goalPlanStore = defaultGoalPlanStore(),
) {
  const fallbackWorkspacePath = normalizeWorkspacePath(workspacePath);
  let plan = null;
  if (conversationId && typeof goalPlanStore?.getActivePlanByConversation === 'function') {
    try {
      plan = goalPlanStore.getActivePlanByConversation(conversationId);
    } catch {
      plan = null;
    }
  }
  const originWorkspacePath =
    normalizeWorkspacePath(plan?.originWorkspacePath) ||
    fallbackWorkspacePath ||
    null;
  const targetWorkspacePath = normalizeWorkspacePath(plan?.targetWorkspacePath);
  const isolatedWorktreePath = plan?.deliveryBinding?.executionIsolation === 'worktree'
    ? normalizeWorkspacePath(plan.deliveryBinding?.worktreePath)
    : null;
  const executionWorkspacePath = isolatedWorktreePath
    || targetWorkspacePath
    || fallbackWorkspacePath
    || originWorkspacePath
    || null;
  const writableRoots = normalizeWorkspaceRoots([
    isolatedWorktreePath || targetWorkspacePath || fallbackWorkspacePath || originWorkspacePath,
  ]);
  const readableRoots = normalizeWorkspaceRoots([
    originWorkspacePath,
    targetWorkspacePath || fallbackWorkspacePath,
    isolatedWorktreePath,
  ]);
  return {
    planId: typeof plan?.planId === 'string' ? plan.planId : null,
    originWorkspacePath,
    targetWorkspacePath,
    executionWorkspacePath,
    writableRoots,
    readableRoots,
    boundaries: plan?.boundaries ?? null,
  };
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
  planGate = null,
  args = null,
  workspacePath = null,
  writableRoots = null,
  boundaries = null,
} = {}) {
  // wire 值迁移后（见 ADR 41 / agent-mode-default-and-adaptive-planning）：
  // - plan 模式：审批门。计划获批前拒绝一切有副作用能力（下方逻辑）。
  // - Agent 默认（wire=chat）与 legacy goal 共用自驱内核，不施加整模式「计划审批门」；
  //   但副作用工作必须先有持久化 GoalPlan，确保执行完成后能进入 Evidence 与用户验收流转。
  // - 无计划时规划 / 提问 / 只读能力仍可用；这不是重复 PermissionGrant，而是任务生命周期准入。
  if (mode === 'goal' || mode === 'chat') {
    // 规划 / 回写 / 提问：始终放行。
    if (PLAN_ALWAYS_ALLOWED_TOOLS.has(toolName)) return { allowed: true };
    // 惰性 / 只读能力：直接放行。
    if (INERT_RISK_LEVELS.has(riskLevel)) return { allowed: true };
    // 有副作用的 Agent 工作必须先建立持久化计划，否则执行结果没有可验收的任务事实。
    if (typeof planGate?.hasPlan === 'boolean' && !planGate.hasPlan) {
      return {
        allowed: false,
        reason: 'goal_plan_required_for_side_effect',
        detail: toolName ?? undefined,
      };
    }
    // intake 判别阶段（方案乙 write-gate）：目标尚未确认，Runner 只做只读/问答/澄清。
    // 上方已放行规划/回写/提问与只读能力；到这里的都是有副作用能力（写文件、shell、
    // MCP 副作用等），在 intake 阶段一律结构化拒绝，直到 intake 收敛为 accepted_goal。
    if (planGate?.intakeActive) {
      return { allowed: false, reason: 'goal_intake_write_blocked', detail: toolName ?? undefined };
    }
    // ① pre-act 写盘范围守卫（write_file / edit_file）。
    if (PATH_WRITE_TOOLS.has(toolName)) {
      const scope = evaluateWriteScope({ args, workspacePath, writableRoots, boundaries });
      if (!scope.allowed) return { allowed: false, reason: scope.reason, detail: scope.detail };
      if (scope.requiresConfirmation) {
        return {
          allowed: true,
          requiresConfirmation: true,
          confirmation: {
            kind: 'scope_expansion',
            detail: scope.detail ?? '',
            reason: scope.reason,
          },
        };
      }
    }
    // ② on-irreversible 不可逆动作 → 放行但要求逐动作确认。
    const irreversible = detectIrreversibleAction({ toolName, args });
    if (irreversible) {
      return { allowed: true, requiresConfirmation: true, confirmation: irreversible };
    }
    if (isHighRiskGoalAction(riskLevel)) {
      return {
        allowed: true,
        requiresConfirmation: true,
        confirmation: {
          kind: 'high_risk',
          detail: toolName ?? '',
          reason: 'goal_high_risk_confirmation',
          riskLevel,
        },
      };
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
  if (reason === 'goal_intake_write_blocked') {
    return zh
      ? 'Goal 模式 intake 判别阶段：当前尚未确认这是一个要执行的目标，仅允许只读调查、提问与产出目标计划。请先用 goal_create_plan 确认目标（升级为正式目标）后，再执行有副作用的操作；若这只是一次问答，直接回答即可。'
      : 'Goal mode intake phase: the goal is not confirmed yet. Only read-only investigation, questions, and producing a goal plan are allowed. Confirm the goal via goal_create_plan (promote to an accepted goal) before running side-effecting actions; if this is just a question, answer directly.';
  }
  if (reason === 'goal_plan_required_for_side_effect') {
    return zh
      ? 'Agent 模式：有副作用的工作必须先用 goal_create_plan 建立可追踪任务，才能执行。小改动可以创建单步骤 Micro GoalPlan；完成后任务会进入自动验证与待用户验收流程。'
      : 'Agent mode: side-effecting work requires a trackable task created via goal_create_plan before execution. Small changes may use a one-step Micro GoalPlan so the result can enter verification and user acceptance.';
  }
  if (reason === 'goal_plan_not_approved') {
    return zh
      ? 'Plan 模式：已有计划但尚未获批准。请通过右侧计划面板/批准卡取得用户批准，获批后再执行有副作用的操作。'
      : 'Plan mode: a plan exists but is not approved yet. Get user approval via the Plan panel/approval card before running side-effecting actions.';
  }
  if (reason === 'goal_scope_out_of_workspace') {
    return zh
      ? 'Goal 模式：拒绝写入未绑定到当前目标的路径。请把写操作限制在 Goal 的目标执行范围内。'
      : 'Goal mode: refusing to write outside the active Goal target. Keep write operations within the Goal execution scope.';
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
  if (reason === 'goal_scope_expansion_denied') {
    return zh
      ? 'Goal 模式：目标路径不在当前 in-scope 边界内，且范围扩展未获用户确认，已拒绝执行。'
      : 'Goal mode: the target path is outside the current in-scope boundary and scope expansion was not confirmed by the user.';
  }
  if (reason === 'goal_high_risk_denied') {
    return zh
      ? 'Goal 模式：高风险动作未获用户确认，已拒绝执行。'
      : 'Goal mode: a high-risk action was not confirmed by the user and was denied.';
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

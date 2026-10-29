import { criterionSourceRevision } from "./project-agent/criterion-review.mjs";
import { randomUUID } from "node:crypto";
import { normalizeGoalCheckpoint } from "@peer-agent/runtime-core";
import { normalizeVisualRepair } from "./goal-visual-repair.mjs";

/** Canonical GoalPlan normalization and domain transitions; no persistence or host lifecycle. */

// maxExplorers 的硬上限护栏。历史语义为「每计划累计可派发 Explorer 总数」，现已弃用
// （不再作为累计闸），仅为兼容旧持久化数据保留字段。此上限继续对异常值做对称钳制。
const MAX_EXPLORERS_HARD_CAP = 10;

// explorerConcurrency 的硬上限护栏。每个 explorer 是一个完整的只读子 Agent loop，
// 直接是 token / 时间成本的乘数。并发上限可经外部（IPC options / runner 状态）传入，
// 此处补一个对称的上限挡住异常值（例如某轮请求几十个时把限流打爆）；默认 5 远低于上限。
const EXPLORER_CONCURRENCY_HARD_CAP = 8;

export const DEFAULT_EXPLORER_CONCURRENCY = 5;

/** ExecutionStatus（execution.ts）——本 store 仅依赖这些字面量做聚合判定。 */
export const TERMINAL_OK = 'completed';

export const TERMINAL_FAIL = 'failed';

export const TERMINAL_CANCEL = 'cancelled';

export const BLOCKED = 'waiting_user';

export const LEAF_TERMINAL_STATUSES = new Set([TERMINAL_OK, TERMINAL_FAIL, TERMINAL_CANCEL]);

const PREVIEW_REVIEW_PENDING = /preview-review-pending/i;

/** Close denied until independent review is not a user question. */
export function isPreviewReviewPendingLeaf(task) {
  if (!task || typeof task !== 'object' || task.status !== BLOCKED) return false;
  return PREVIEW_REVIEW_PENDING.test(`${task.blockedReason ?? ''} ${task.result ?? ''} ${task.failureReason ?? ''}`);
}

/** Plan 终态：关闭 active segment 并落盘 duration。 */
export const PLAN_TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

/** 停表状态：人在回路 / 暂停 / 已中断挂起。 */
const PLAN_PAUSE_STATUSES = new Set(['paused', 'interrupted']);

/** 开表状态：真正在跑。 */
const PLAN_ACTIVE_STATUSES = new Set(['executing']);

function toIsoOrNull(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return Number.isFinite(Date.parse(trimmed)) ? trimmed : null;
}

function nonNegInt(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.floor(n));
}

/**
 * 规范化 GoalTiming 账本。历史 plan 无 timing 时返回 undefined。
 * @param {object|null|undefined} timing
 * @returns {object|undefined}
 */
export function normalizeGoalTiming(timing) {
  if (!timing || typeof timing !== 'object') return undefined;
  const startedAt = toIsoOrNull(timing.startedAt) || undefined;
  const completedAt = toIsoOrNull(timing.completedAt) || undefined;
  const activeSegmentStartedAt = toIsoOrNull(timing.activeSegmentStartedAt) || undefined;
  const activeAccumulatedMs = nonNegInt(timing.activeAccumulatedMs, 0);
  const next = {
    activeAccumulatedMs,
  };
  if (startedAt) next.startedAt = startedAt;
  if (completedAt) next.completedAt = completedAt;
  if (activeSegmentStartedAt) next.activeSegmentStartedAt = activeSegmentStartedAt;
  if (typeof timing.wallClockMs === 'number' && Number.isFinite(timing.wallClockMs)) {
    next.wallClockMs = nonNegInt(timing.wallClockMs, 0);
  }
  if (typeof timing.activeMs === 'number' && Number.isFinite(timing.activeMs)) {
    next.activeMs = nonNegInt(timing.activeMs, 0);
  }
  // 没有任何时间标记且累计为 0 → 视为缺省
  if (!startedAt && !completedAt && !activeSegmentStartedAt
    && activeAccumulatedMs === 0
    && next.wallClockMs === undefined
    && next.activeMs === undefined) {
    return undefined;
  }
  return next;
}

function closeActiveSegment(timing, nowIso) {
  const base = {
    activeAccumulatedMs: nonNegInt(timing?.activeAccumulatedMs, 0),
  };
  if (timing?.startedAt) base.startedAt = timing.startedAt;
  if (timing?.completedAt) base.completedAt = timing.completedAt;
  if (typeof timing?.wallClockMs === 'number') base.wallClockMs = nonNegInt(timing.wallClockMs, 0);
  if (typeof timing?.activeMs === 'number') base.activeMs = nonNegInt(timing.activeMs, 0);

  const segmentStart = toIsoOrNull(timing?.activeSegmentStartedAt);
  if (!segmentStart) {
    // 无 open segment，仅去掉字段
    return base;
  }
  const startMs = Date.parse(segmentStart);
  const endMs = Date.parse(nowIso);
  if (Number.isFinite(startMs) && Number.isFinite(endMs)) {
    base.activeAccumulatedMs += Math.max(0, endMs - startMs);
  }
  return base;
}

function openActiveSegment(timing, nowIso) {
  const base = {
    activeAccumulatedMs: nonNegInt(timing?.activeAccumulatedMs, 0),
    activeSegmentStartedAt: nowIso,
  };
  if (timing?.startedAt) base.startedAt = timing.startedAt;
  // 重新开跑时清掉终态字段
  return base;
}

/**
 * 按 plan 新状态推进时间账本。
 * - 首次进入 executing：写 startedAt + open segment
 * - pause / 终态：close segment；终态再落盘 wallClockMs/activeMs
 * - resume → executing：open segment（startedAt 不重置）
 *
 * @param {object|null|undefined} prevTiming
 * @param {string|undefined} prevStatus
 * @param {string} nextStatus
 * @param {string} [nowIso]
 * @returns {object|undefined}
 */
export function applyGoalTimingTransition(prevTiming, prevStatus, nextStatus, nowIso = new Date().toISOString()) {
  if (!nextStatus || prevStatus === nextStatus) {
    return normalizeGoalTiming(prevTiming);
  }

  let timing = normalizeGoalTiming(prevTiming) || { activeAccumulatedMs: 0 };
  const now = toIsoOrNull(nowIso) || new Date().toISOString();

  // 进入有效运行
  if (PLAN_ACTIVE_STATUSES.has(nextStatus)) {
    if (!timing.startedAt) timing.startedAt = now;
    // 从停表/草稿进入执行：开 segment；若已在跑且有 open segment 则保持
    if (!timing.activeSegmentStartedAt) {
      timing = openActiveSegment(timing, now);
    } else {
      // 清除终态字段（若从 failed 等恢复）
      const { completedAt: _c, wallClockMs: _w, activeMs: _a, ...rest } = timing;
      timing = rest;
    }
    return normalizeGoalTiming(timing);
  }

  // 停表（paused）
  if (PLAN_PAUSE_STATUSES.has(nextStatus)) {
    timing = closeActiveSegment(timing, now);
    return normalizeGoalTiming(timing);
  }

  // 终态
  if (PLAN_TERMINAL_STATUSES.has(nextStatus)) {
    timing = closeActiveSegment(timing, now);
    if (!timing.startedAt) {
      // 从未真正开跑就终态：不伪造 startedAt
      return normalizeGoalTiming({
        ...timing,
        completedAt: now,
        activeMs: nonNegInt(timing.activeAccumulatedMs, 0),
        wallClockMs: 0,
      });
    }
    const startedMs = Date.parse(timing.startedAt);
    const completedMs = Date.parse(now);
    const wallClockMs = Number.isFinite(startedMs) && Number.isFinite(completedMs)
      ? Math.max(0, completedMs - startedMs)
      : 0;
    return normalizeGoalTiming({
      ...timing,
      completedAt: now,
      activeMs: nonNegInt(timing.activeAccumulatedMs, 0),
      wallClockMs,
    });
  }

  // 其他状态（drafting / awaiting_approval / approved / accepted）：若有 open segment 则关掉
  // （例如从 executing 回退到 approved 的异常路径）
  if (timing.activeSegmentStartedAt) {
    timing = closeActiveSegment(timing, now);
  }
  return normalizeGoalTiming(timing);
}

/**
 * 自底向上聚合进度。约束（提案 §4）：
 * - 只统计叶子任务（无 subtasks 的任务）；父任务状态由叶子派生，不单独计数。
 * - completed / failed / blocked 分别计数，percent = completed / total * 100。
 *
 * @param {Array} tasks 顶层子任务树
 * @returns {{total:number,completed:number,failed:number,blocked:number,percent:number}}
 */
export function aggregateProgress(tasks) {
  let total = 0;
  let completed = 0;
  let failed = 0;
  let blocked = 0;

  const walk = (list) => {
    for (const t of list || []) {
      const children = Array.isArray(t.subtasks) ? t.subtasks : [];
      if (children.length > 0) {
        walk(children);
        continue;
      }
      // 叶子任务
      total += 1;
      if (t.status === TERMINAL_OK) completed += 1;
      else if (t.status === TERMINAL_FAIL) failed += 1;
      else if (t.status === BLOCKED) blocked += 1;
    }
  };
  walk(tasks);

  const percent = total === 0 ? 0 : Math.round((completed / total) * 100);
  return { total, completed, failed, blocked, percent };
}

export function derivePlanStatus(currentStatus, tasks) {
  const inspectLeaves = (list) => {
    let leafTotal = 0;
    let allTerminal = true;
    let hasFailed = false;
    let hasRunning = false;
    const walkLeaves = (nodes) => {
      for (const t of nodes || []) {
        const children = Array.isArray(t.subtasks) ? t.subtasks : [];
        if (children.length > 0) {
          walkLeaves(children);
          continue;
        }
        leafTotal += 1;
        if (t.status === TERMINAL_FAIL) hasFailed = true;
        else if (!LEAF_TERMINAL_STATUSES.has(t.status)) allTerminal = false;
        if (t.status === 'running') hasRunning = true;
      }
    };
    walkLeaves(list);
    return { leafTotal, allTerminal, hasFailed, hasRunning };
  };

  // 规则 2/3：executing 自动收尾；failed/interrupted 计划在叶子被显式重试为 running 时
  // 恢复执行，或在叶子事实已全部成功完成时恢复为 completed。未消费的 Runner interruption
  // 只在「工作已停」且叶子仍未全部成功时由 persist 钉在 interrupted（ADR 73：可恢复挂起
  // 而非失败）。叶子或 Runner 继续执行时，persist 必须让计划回到 executing，不能把
  // 「已中断」和「运行中」钉在同一条契约上。叶子已全部成功完成时，中断只是过期的
  // runner 事实，不能挡住 completed。重试预算耗尽的失败仍落 failed 终态。
  if (
    currentStatus === 'executing'
    || currentStatus === 'failed'
    || currentStatus === 'interrupted'
  ) {
    const { leafTotal, allTerminal, hasFailed, hasRunning } = inspectLeaves(tasks);
    if (leafTotal > 0 && allTerminal) {
      return hasFailed ? TERMINAL_FAIL : TERMINAL_OK;
    }
    if ((currentStatus === 'failed' || currentStatus === 'interrupted') && hasRunning) {
      return 'executing';
    }
    return currentStatus;
  }

  // 规则 1：approved/accepted + 已有活跃/终态叶子 → executing。
  // accepted 覆盖自驱 Goal（无 Plan 批准闸门）；drafting/awaiting_approval/paused/cancelled 等保持原样。
  if (currentStatus !== 'approved' && currentStatus !== 'accepted') return currentStatus;

  let started = false;
  const walk = (list) => {
    for (const t of list || []) {
      if (started) return;
      const children = Array.isArray(t.subtasks) ? t.subtasks : [];
      if (children.length > 0) {
        walk(children);
        continue;
      }
      if (
        t.status === 'running' ||
        t.status === TERMINAL_OK ||
        t.status === TERMINAL_FAIL ||
        t.status === TERMINAL_CANCEL ||
        t.status === BLOCKED
      ) {
        started = true;
        return;
      }
    }
  };
  walk(tasks);

  return started ? 'executing' : currentStatus;
}

const RUNNER_STATUSES = new Set([
  'idle',
  'running',
  'compacting_context',
  'resuming_after_compaction',
  'paused',
  'exploring',
  'waiting_user',
  'blocked',
  'budget_exhausted',
  'completed',
  'failed',
]);

const RUNNER_INTENTS = new Set(['execute', 'verify', 'explore', 'synthesize', 'block']);

export const EXPLORER_STATUSES = new Set(['queued', 'running', 'completed', 'failed', 'cancelled']);

const EXPLORER_CONFIDENCE = new Set(['low', 'medium', 'high']);

const VERIFIER_STATUSES = new Set(['queued', 'running', 'passed', 'failed', 'blocked']);

const VERIFIER_TERMINAL_STATUSES = new Set(['passed', 'failed', 'blocked']);

const VERIFIER_TARGET_KINDS = new Set(['plan', 'task', 'success_criterion']);

const GOAL_RUN_EVENT_TYPES = new Set([
  'message_routed',
  'goal_intake_started',
  'goal_created',
  'plan_created',
  'plan_revised',
  'step_started',
  'step_completed',
  'action_started',
  'action_completed',
  'observation_recorded',
  'validation_started',
  'validation_passed',
  'validation_failed',
  'problem_found',
  'user_correction',
  'requirement_override',
  'self_correction',
  'checkpoint_created',
  'goal_checkpoint_prepared',
  'goal_checkpoint_committed',
  'goal_compaction_persisted',
  'goal_checkpoint_consumed',
  'goal_checkpoint_superseded',
  'network_interrupted',
  'goal_resumed',
  'child_goal_created',
  'child_goal_started',
  'child_goal_completed',
  'child_goal_failed',
  'parent_goal_resumed',
  'goal_paused',
  'goal_completed',
]);

const WORKFLOW_KINDS = new Set(['plan_approval', 'goal_self_driven']);

const ACTIVATION_KINDS = new Set(['intake', 'approval_required', 'approved_plan', 'accepted_goal']);

const INTAKE_RESOLUTIONS = new Set(['inquiry', 'clarifying', 'goal_confirmed']);

const AUTONOMY_KINDS = new Set(['approval_gated', 'self_driven']);

const WRITE_SCOPES = new Set(['workspace_and_boundaries']);

export const CONFIRMATION_DECISIONS = new Set(['approve', 'reject', 'revise']);

const MANUAL_CONFIRMATION_KINDS = new Set(['manual_dod']);

const GOAL_RUNNER_PHASES = new Set([
  'orient',
  'inspect',
  'plan_scaffold',
  'act',
  'verify',
  'repair',
  'quality_review',
  'synthesize',
  'waiting_user',
  'blocked',
]);

const QUALITY_REVIEW_STATUSES = new Set(['reviewing', 'passed', 'failed']);

const QUALITY_CHECK_STATUSES = new Set(['passed', 'failed', 'skipped']);

const QUALITY_CHECK_IDS = new Set(['intent', 'mechanical', 'artifact', 'integration']);

const ASK_USER_REASONS = new Set([
  'ambiguous_goal',
  'product_decision',
  'high_risk',
  'irreversible',
  'missing_permission',
  'missing_credentials',
  'verification_conflict',
  'scope_drift',
]);

const DEFAULT_APPROVAL_GATED_POLICY = Object.freeze({
  autonomy: 'approval_gated',
  irreversibleRequiresConfirmation: true,
  writeScope: 'workspace_and_boundaries',
  askUserOn: [
    'ambiguous_goal',
    'product_decision',
    'high_risk',
    'irreversible',
    'missing_permission',
    'missing_credentials',
    'verification_conflict',
    'scope_drift',
  ],
});

export const DEFAULT_SELF_DRIVEN_POLICY = Object.freeze({
  autonomy: 'self_driven',
  irreversibleRequiresConfirmation: true,
  writeScope: 'workspace_and_boundaries',
  askUserOn: [
    'ambiguous_goal',
    'product_decision',
    'high_risk',
    'irreversible',
    'missing_permission',
    'missing_credentials',
    'verification_conflict',
    'scope_drift',
  ],
});

export function normalizeStringArray(value) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim())
    : [];
}

export function normalizeOptionalString(value) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
}

export function normalizeEvidenceRefList(value) {
  if (typeof value === 'string') return normalizeStringArray([value]);
  return normalizeStringArray(value);
}

export function normalizeWorkflowKind(value) {
  return WORKFLOW_KINDS.has(value) ? value : 'plan_approval';
}

function defaultExecutionPolicyForWorkflow(workflowKind) {
  return workflowKind === 'goal_self_driven'
    ? DEFAULT_SELF_DRIVEN_POLICY
    : DEFAULT_APPROVAL_GATED_POLICY;
}

export function normalizeActivation(value, workflowKind, status) {
  const now = new Date().toISOString();
  if (value && typeof value === 'object') {
    const kind = ACTIVATION_KINDS.has(value.kind) ? value.kind : null;
    if (kind) {
      const activation = { kind };
      if (typeof value.sourceMessageId === 'string' && value.sourceMessageId.trim()) {
        activation.sourceMessageId = value.sourceMessageId.trim();
      }
      if (typeof value.acceptedAt === 'string' && value.acceptedAt.trim()) {
        activation.acceptedAt = value.acceptedAt.trim();
      }
      if (typeof value.acceptedBy === 'string' && value.acceptedBy.trim()) {
        activation.acceptedBy = value.acceptedBy.trim();
      }
      if (INTAKE_RESOLUTIONS.has(value.intakeResolution)) {
        activation.intakeResolution = value.intakeResolution;
      }
      return activation;
    }
  }
  if (workflowKind === 'goal_self_driven') {
    return { kind: 'accepted_goal', acceptedAt: now, acceptedBy: 'user' };
  }
  if (status === 'approved' || status === 'executing' || status === 'paused') {
    return { kind: 'approved_plan' };
  }
  return { kind: 'approval_required' };
}

export function normalizeExecutionPolicy(value, workflowKind) {
  const fallback = defaultExecutionPolicyForWorkflow(workflowKind);
  if (!value || typeof value !== 'object') return { ...fallback };
  const autonomy = AUTONOMY_KINDS.has(value.autonomy) ? value.autonomy : fallback.autonomy;
  const writeScope = WRITE_SCOPES.has(value.writeScope) ? value.writeScope : fallback.writeScope;
  const askUserOn = Array.isArray(value.askUserOn)
    ? value.askUserOn.filter((reason) => ASK_USER_REASONS.has(reason))
    : fallback.askUserOn;
  return {
    autonomy,
    irreversibleRequiresConfirmation:
      typeof value.irreversibleRequiresConfirmation === 'boolean'
        ? value.irreversibleRequiresConfirmation
        : fallback.irreversibleRequiresConfirmation,
    writeScope,
    askUserOn: askUserOn.length > 0 ? askUserOn : fallback.askUserOn,
  };
}

// 成功标准（DoD）的可选类型。command/test/file-contains/file-exists 可被机器自动
// 验证；manual 需人工确认。见 goal-mode-ultrathink-workflow 设计文档「DoD-as-Code」。
const CRITERION_KINDS = new Set(['command', 'test', 'file-contains', 'file-exists', 'model_review', 'manual']);

/**
 * 规范化单条成功标准（SuccessCriterion）。两种输入形态均向后兼容：
 * - 纯字符串 → 归一为 { id, kind:'manual', description }（旧计划/口头 DoD）
 * - 结构化对象 → 按 kind 保留可自动验证所需字段（command/path/expect）
 * 非法/空输入返回 null，由调用方过滤。
 */
function normalizeSuccessCriterion(value, index = 0) {
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return null;
    return { id: `c${index + 1}`, kind: 'manual', description: text };
  }
  if (!value || typeof value !== 'object') return null;
  const rawKind = typeof value.kind === 'string' ? value.kind.trim() : '';
  const kind = CRITERION_KINDS.has(rawKind) ? rawKind : 'manual';
  const id = typeof value.id === 'string' && value.id.trim() ? value.id.trim() : `c${index + 1}`;
  let description = typeof value.description === 'string' ? value.description.trim() : '';
  const command = typeof value.command === 'string' ? value.command.trim() : '';
  const targetPath = typeof value.path === 'string' ? value.path.trim() : '';
  const expect = typeof value.expect === 'string' ? value.expect.trim() : '';
  if (!description) {
    // 无描述时用可用字段兜底，保证渲染/审计可读。
    description = command || targetPath || '(unnamed criterion)';
  }
  const criterion = { id, kind, description };
  if (Array.isArray(value.requiredCapabilities)) criterion.requiredCapabilities = value.requiredCapabilities.filter(id => typeof id === 'string');
  if (command) criterion.command = command;
  if (targetPath) criterion.path = targetPath;
  if (expect) criterion.expect = expect;
  if (value.authority && ['model', 'user', 'project_policy', 'legacy_unknown'].includes(value.authority.source)) {
    criterion.authority = { ...value.authority };
  }
  return criterion;
}

export function normalizeSuccessCriteria(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => normalizeSuccessCriterion(item, index)).filter(Boolean);
}

/**
 * 规范化单条验证结果（CriterionResult）。每条对应一个 successCriterion.id，
 * 记录该标准是否通过、佐证的 evidenceRef 与检查详情。缺 criterionId 视为非法。
 */
function normalizeCriterionResult(value) {
  if (!value || typeof value !== 'object') return null;
  const criterionId = typeof value.criterionId === 'string' ? value.criterionId.trim() : '';
  if (!criterionId) return null;
  const result = { criterionId, passed: value.passed === true };
  if (typeof value.evidenceRef === 'string' && value.evidenceRef.trim()) {
    result.evidenceRef = value.evidenceRef.trim();
  }
  if (typeof value.detail === 'string' && value.detail.trim()) {
    result.detail = value.detail.trim();
  }
  if (typeof value.checkedAt === 'string' && value.checkedAt.trim()) {
    result.checkedAt = value.checkedAt.trim();
  }
  return result;
}

export function normalizeCriterionResults(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => normalizeCriterionResult(item)).filter(Boolean);
}

export function normalizeManualConfirmation(value) {
  if (!value || typeof value !== 'object') return null;
  const kind = MANUAL_CONFIRMATION_KINDS.has(value.kind) ? value.kind : null;
  const decision = CONFIRMATION_DECISIONS.has(value.decision) ? value.decision : null;
  const criterionIds = normalizeStringArray(value.criterionIds);
  if (!kind || !decision || criterionIds.length === 0) return null;
  const confirmationId = typeof value.confirmationId === 'string' && value.confirmationId.trim()
    ? value.confirmationId.trim()
    : randomUUID();
  const decidedAt = typeof value.decidedAt === 'string' && value.decidedAt.trim()
    ? value.decidedAt.trim()
    : new Date().toISOString();
  const confirmation = {
    confirmationId,
    kind,
    decision,
    criterionIds,
    decidedAt,
  };
  if (typeof value.decidedBy === 'string' && value.decidedBy.trim()) {
    confirmation.decidedBy = value.decidedBy.trim();
  }
  if (typeof value.feedback === 'string' && value.feedback.trim()) {
    confirmation.feedback = value.feedback.trim();
  }
  return confirmation;
}

export function normalizeManualConfirmations(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => normalizeManualConfirmation(item)).filter(Boolean);
}

function normalizeExplorerRequest(request, fallback = {}) {
  const now = new Date().toISOString();
  const explorerId = typeof request?.explorerId === 'string' && request.explorerId.trim()
    ? request.explorerId.trim()
    : fallback.explorerId;
  const planId = typeof request?.planId === 'string' && request.planId.trim()
    ? request.planId.trim()
    : fallback.planId;
  if (!explorerId || !planId) return null;
  const scope = request?.scope && typeof request.scope === 'object'
    ? {
        include: normalizeStringArray(request.scope.include),
        exclude: normalizeStringArray(request.scope.exclude),
      }
    : undefined;
  const normalized = {
    explorerId,
    planId,
    question: typeof request?.question === 'string' && request.question.trim()
      ? request.question.trim()
      : '为当前目标补齐缺失的信息',
    reason: typeof request?.reason === 'string' && request.reason.trim()
      ? request.reason.trim()
      : '需要先只读查一下资料',
    profile: 'readonly_explorer',
    budget: {
      maxToolCalls: Number.isFinite(request?.budget?.maxToolCalls)
        ? Math.max(1, Math.trunc(request.budget.maxToolCalls))
        : Number.isFinite(request?.maxToolCalls)
          ? Math.max(1, Math.trunc(request.maxToolCalls))
          : 8,
      maxDurationMs: Number.isFinite(request?.budget?.maxDurationMs)
        ? Math.max(1000, Math.trunc(request.budget.maxDurationMs))
        : Number.isFinite(request?.maxDurationMs)
          ? Math.max(1000, Math.trunc(request.maxDurationMs))
          : 120000,
    },
    exitCriteria: normalizeStringArray(request?.exitCriteria),
    createdAt: typeof request?.createdAt === 'string' && request.createdAt.trim()
      ? request.createdAt
      : now,
  };
  if (scope && (scope.include.length > 0 || scope.exclude.length > 0)) normalized.scope = scope;
  return normalized;
}

export function normalizeExplorerReport(report, fallback = {}) {
  if (!report || typeof report !== 'object') return undefined;
  const explorerId = typeof report.explorerId === 'string' && report.explorerId.trim()
    ? report.explorerId.trim()
    : fallback.explorerId;
  const planId = typeof report.planId === 'string' && report.planId.trim()
    ? report.planId.trim()
    : fallback.planId;
  if (!explorerId || !planId) return undefined;
  const findings = Array.isArray(report.findings)
    ? report.findings
        .map((finding) => ({
          claim: typeof finding?.claim === 'string' ? finding.claim.trim() : '',
          evidenceRefs: normalizeStringArray(finding?.evidenceRefs),
        }))
        .filter((finding) => finding.claim && finding.evidenceRefs.length > 0)
    : [];
  const normalized = {
    explorerId,
    planId,
    question: typeof report.question === 'string' && report.question.trim()
      ? report.question.trim()
      : fallback.question || '',
    findings,
    evidenceRefs: normalizeStringArray(report.evidenceRefs),
    confidence: EXPLORER_CONFIDENCE.has(report.confidence) ? report.confidence : 'low',
  };
  if (typeof report.recommendedNextAction === 'string' && report.recommendedNextAction.trim()) {
    normalized.recommendedNextAction = report.recommendedNextAction.trim();
  }
  if (typeof report.blockedReason === 'string' && report.blockedReason.trim()) {
    normalized.blockedReason = report.blockedReason.trim();
  }
  return normalized;
}

export function normalizeExplorerRun(run, fallback = {}) {
  if (!run || typeof run !== 'object') return null;
  const explorerId = typeof run.explorerId === 'string' && run.explorerId.trim()
    ? run.explorerId.trim()
    : fallback.explorerId;
  const request = normalizeExplorerRequest(run.request, { explorerId, planId: fallback.planId });
  if (!request) return null;
  const now = new Date().toISOString();
  const status = EXPLORER_STATUSES.has(run.status) ? run.status : 'queued';
  const normalized = {
    explorerId: request.explorerId,
    status,
    request,
    createdAt: typeof run.createdAt === 'string' && run.createdAt.trim() ? run.createdAt : request.createdAt,
    updatedAt: typeof run.updatedAt === 'string' && run.updatedAt.trim() ? run.updatedAt : now,
  };
  const report = normalizeExplorerReport(run.report, {
    explorerId: request.explorerId,
    planId: request.planId,
    question: request.question,
  });
  if (report) normalized.report = report;
  const evidenceRefs = normalizeStringArray(run.evidenceRefs);
  if (evidenceRefs.length > 0) normalized.evidenceRefs = evidenceRefs;
  if (typeof run.failureReason === 'string' && run.failureReason.trim()) {
    normalized.failureReason = run.failureReason.trim();
  }
  const batchId = typeof run.batchId === 'string' && run.batchId.trim()
    ? run.batchId.trim()
    : (typeof fallback.batchId === 'string' && fallback.batchId.trim() ? fallback.batchId.trim() : undefined);
  if (batchId) normalized.batchId = batchId;
  return normalized;
}

function normalizeExploreQuestion(question) {
  if (!question || typeof question !== 'object') return null;
  const text = typeof question.question === 'string' && question.question.trim()
    ? question.question.trim()
    : '';
  if (!text) return null;
  const reason = typeof question.reason === 'string' && question.reason.trim()
    ? question.reason.trim()
    : 'Deterministic inspect requires more read-only evidence before acting';
  const normalized = { question: text, reason };
  const include = normalizeStringArray(question.scope?.include);
  const exclude = normalizeStringArray(question.scope?.exclude);
  if (include.length > 0 || exclude.length > 0) {
    normalized.scope = {
      ...(include.length > 0 ? { include } : {}),
      ...(exclude.length > 0 ? { exclude } : {}),
    };
  }
  const budget = question.budget && typeof question.budget === 'object' ? question.budget : {};
  const normalizedBudget = {};
  if (Number.isFinite(budget.maxToolCalls)) {
    normalizedBudget.maxToolCalls = Math.max(1, Math.trunc(budget.maxToolCalls));
  }
  if (Number.isFinite(budget.maxDurationMs)) {
    normalizedBudget.maxDurationMs = Math.max(1000, Math.trunc(budget.maxDurationMs));
  }
  if (Object.keys(normalizedBudget).length > 0) normalized.budget = normalizedBudget;
  return normalized;
}

function normalizeExplorePlan(plan) {
  if (!plan || typeof plan !== 'object') return undefined;
  const questions = Array.isArray(plan.questions)
    ? plan.questions.map(normalizeExploreQuestion).filter(Boolean)
    : [];
  const generatedAt = typeof plan.generatedAt === 'string' && plan.generatedAt.trim()
    ? plan.generatedAt.trim()
    : new Date().toISOString();
  return {
    requiredBeforeAct: Boolean(plan.requiredBeforeAct) && questions.length > 0,
    questions,
    exitCriteria: normalizeStringArray(plan.exitCriteria),
    generatedAt,
  };
}

function normalizeVerifierTarget(target, fallback = {}) {
  const source = target && typeof target === 'object' ? target : {};
  const rawKind = typeof source.kind === 'string' && source.kind.trim()
    ? source.kind.trim()
    : fallback.kind;
  const inferredKind = typeof source.criterionId === 'string' && source.criterionId.trim()
    ? 'success_criterion'
    : typeof source.taskId === 'string' && source.taskId.trim()
      ? 'task'
      : 'plan';
  const kind = VERIFIER_TARGET_KINDS.has(rawKind) ? rawKind : inferredKind;
  const normalized = { kind };
  if (kind === 'task') {
    const taskId = typeof source.taskId === 'string' && source.taskId.trim()
      ? source.taskId.trim()
      : fallback.taskId;
    if (!taskId) return null;
    normalized.taskId = taskId;
  } else if (kind === 'success_criterion') {
    const criterionId = typeof source.criterionId === 'string' && source.criterionId.trim()
      ? source.criterionId.trim()
      : fallback.criterionId;
    if (!criterionId) return null;
    normalized.criterionId = criterionId;
  }
  return normalized;
}

function normalizeVerifierIssue(issue) {
  if (!issue || typeof issue !== 'object') return null;
  const reason = typeof issue.reason === 'string' && issue.reason.trim()
    ? issue.reason.trim()
    : '';
  if (!reason) return null;
  const normalized = {
    reason,
    evidenceRefs: normalizeStringArray(issue.evidenceRefs),
  };
  if (typeof issue.taskId === 'string' && issue.taskId.trim()) {
    normalized.taskId = issue.taskId.trim();
  }
  if (typeof issue.criterionId === 'string' && issue.criterionId.trim()) {
    normalized.criterionId = issue.criterionId.trim();
  }
  return normalized;
}

function normalizeVerifierReport(report) {
  if (!report || typeof report !== 'object') return undefined;
  return {
    passed: report.passed === true,
    failedCriteria: Array.isArray(report.failedCriteria)
      ? report.failedCriteria.map(normalizeVerifierIssue).filter(Boolean)
      : [],
    missingEvidence: Array.isArray(report.missingEvidence)
      ? report.missingEvidence.map(normalizeVerifierIssue).filter(Boolean)
      : [],
    risks: normalizeStringArray(report.risks),
    evidenceRefs: normalizeStringArray(report.evidenceRefs),
    ...(typeof report.recommendedNextAction === 'string' && report.recommendedNextAction.trim()
      ? { recommendedNextAction: report.recommendedNextAction.trim() }
      : {}),
  };
}

export function normalizeVerifierRun(run, fallback = {}) {
  if (!run || typeof run !== 'object') return null;
  const verifierRunId = typeof run.verifierRunId === 'string' && run.verifierRunId.trim()
    ? run.verifierRunId.trim()
    : fallback.verifierRunId;
  const planId = typeof run.planId === 'string' && run.planId.trim()
    ? run.planId.trim()
    : fallback.planId;
  if (!verifierRunId || !planId) return null;
  const now = new Date().toISOString();
  const target = normalizeVerifierTarget(run.target ?? run, fallback.target);
  if (!target) return null;
  const status = VERIFIER_STATUSES.has(run.status) ? run.status : 'queued';
  const normalized = {
    verifierRunId,
    planId,
    target,
    status,
    evidenceRefs: normalizeStringArray(run.evidenceRefs),
    createdAt: typeof run.createdAt === 'string' && run.createdAt.trim() ? run.createdAt : now,
    updatedAt: typeof run.updatedAt === 'string' && run.updatedAt.trim() ? run.updatedAt : now,
  };
  const report = normalizeVerifierReport(run.report);
  if (report) {
    normalized.report = report;
    if (normalized.evidenceRefs.length === 0 && report.evidenceRefs.length > 0) {
      normalized.evidenceRefs = report.evidenceRefs;
    }
  }
  if (typeof run.summary === 'string' && run.summary.trim()) {
    normalized.summary = run.summary.trim();
  }
  if (typeof run.failureReason === 'string' && run.failureReason.trim()) {
    normalized.failureReason = run.failureReason.trim();
  }
  if (typeof run.completedAt === 'string' && run.completedAt.trim()) {
    normalized.completedAt = run.completedAt.trim();
  } else if (VERIFIER_TERMINAL_STATUSES.has(status)) {
    normalized.completedAt = now;
  }
  return normalized;
}

export function normalizeRunEvent(event, fallback = {}) {
  if (!event || typeof event !== 'object') return null;
  const goalPlanId = normalizeOptionalString(event.goalPlanId) || normalizeOptionalString(fallback.goalPlanId);
  const type = GOAL_RUN_EVENT_TYPES.has(event.type) ? event.type : null;
  if (!goalPlanId || !type) return null;
  const now = new Date().toISOString();
  const normalized = {
    id: normalizeOptionalString(event.id) || randomUUID(),
    goalPlanId,
    type,
    summary: normalizeOptionalString(event.summary) || type,
    evidenceRefs: normalizeEvidenceRefList(event.evidenceRefs),
    createdAt: normalizeOptionalString(event.createdAt) || now,
  };
  const nodeId = normalizeOptionalString(event.nodeId);
  if (nodeId) normalized.nodeId = nodeId;
  const parentNodeId = normalizeOptionalString(event.parentNodeId);
  if (parentNodeId) normalized.parentNodeId = parentNodeId;
  if (event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)) {
    normalized.payload = event.payload;
  }
  return normalized;
}

export function normalizeRunTrace(trace, fallback = {}) {
  const events = Array.isArray(trace?.events)
    ? trace.events.map((event) => normalizeRunEvent(event, fallback)).filter(Boolean)
    : [];
  const normalized = { events };
  const activeNodeId = normalizeOptionalString(trace?.activeNodeId);
  if (activeNodeId) normalized.activeNodeId = activeNodeId;
  const lastCheckpointNodeId = normalizeOptionalString(trace?.lastCheckpointNodeId);
  if (lastCheckpointNodeId) normalized.lastCheckpointNodeId = lastCheckpointNodeId;
  return normalized;
}

export function normalizeConversationId(value) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
}

// 目标要改动的代码仓绝对路径（可与会话工作区不同，例如"知识库驱动代码库"场景）。
// 归一化镜像 normalizeConversationId：trim 后空串归一为 null，供 Explorer 派发时注入。
export function normalizeWorkspacePath(value) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
}

const TARGET_BRANCH_SOURCES = new Set(['user_confirmed', 'workspace_head', 'preconfigured']);

const EXECUTION_ISOLATIONS = new Set(['none', 'worktree']);

/** Trim a non-empty string. Never invent a default such as `main`. */
export function normalizeQualityReview(value) {
  if (!value || typeof value !== 'object') return undefined;
  if (!QUALITY_REVIEW_STATUSES.has(value.status)) return undefined;
  const checks = Array.isArray(value.checks)
    ? value.checks
      .map((check) => {
        if (!check || typeof check !== 'object') return null;
        if (!QUALITY_CHECK_IDS.has(check.id) || !QUALITY_CHECK_STATUSES.has(check.status)) return null;
        const label = typeof check.label === 'string' && check.label.trim()
          ? check.label.trim()
          : check.id;
        const next = { id: check.id, label, status: check.status };
        if (typeof check.note === 'string' && check.note.trim()) next.note = check.note.trim();
        return next;
      })
      .filter(Boolean)
    : [];
  const review = { status: value.status };
  if (typeof value.reviewedAt === 'string' && value.reviewedAt.trim()) {
    review.reviewedAt = value.reviewedAt.trim();
  }
  if (checks.length > 0) review.checks = checks;
  return review;
}

const DELIVERY_HANDOFF_STATUSES = new Set(['idle', 'delivering', 'delivered', 'stopped']);

const DELIVERY_MODES = new Set(['merge', 'direct']);

export function normalizeDeliveryHandoff(value) {
  if (!value || typeof value !== 'object') return undefined;
  if (!DELIVERY_HANDOFF_STATUSES.has(value.status)) return undefined;
  const handoff = { status: value.status };
  // ADR 68：交付模式；缺省 merge（存量数据无此字段）。
  if (DELIVERY_MODES.has(value.deliveryMode)) handoff.deliveryMode = value.deliveryMode;
  const repoId = normalizeOptionalName(value.repoId);
  if (repoId) handoff.repoId = repoId;
  const targetBranch = normalizeOptionalName(value.targetBranch);
  if (targetBranch) handoff.targetBranch = targetBranch;
  const taskBranch = normalizeOptionalName(value.taskBranch);
  if (taskBranch) handoff.taskBranch = taskBranch;
  const commitSha = normalizeOptionalName(value.commitSha);
  if (commitSha) handoff.commitSha = commitSha;
  const stoppedReason = normalizeOptionalName(value.stoppedReason);
  if (stoppedReason) handoff.stoppedReason = stoppedReason;
  if (typeof value.updatedAt === 'string' && value.updatedAt.trim()) {
    handoff.updatedAt = value.updatedAt.trim();
  }
  return handoff;
}

export function normalizeOptionalName(value) {
  if (value === undefined || value === null) return undefined;
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : undefined;
}

export function normalizeTargetBranchSource(value) {
  if (typeof value !== 'string') return undefined;
  return TARGET_BRANCH_SOURCES.has(value) ? value : undefined;
}

function normalizeExecutionIsolation(value) {
  if (typeof value !== 'string') return undefined;
  return EXECUTION_ISOLATIONS.has(value) ? value : undefined;
}

/**
 * Persist an explicit delivery binding only. Missing branch / source means
 * unbound — do not fall back to main or the origin workspace branch.
 */
export function normalizeDeliveryBinding(value, fallbacks = {}) {
  if (!value || typeof value !== 'object') return undefined;
  const repoId = normalizeOptionalName(value.repoId);
  const targetBranch = normalizeOptionalName(value.targetBranch);
  const targetBranchSource = normalizeTargetBranchSource(value.targetBranchSource);
  if (!repoId || !targetBranch || !targetBranchSource) return undefined;
  const binding = {
    repoId,
    targetBranch,
    targetBranchSource,
    executionIsolation: normalizeExecutionIsolation(value.executionIsolation) || 'none',
    boundAt: typeof value.boundAt === 'string' && value.boundAt.trim()
      ? value.boundAt.trim()
      : (fallbacks.boundAt || new Date().toISOString()),
  };
  const targetWorkspacePath = normalizeWorkspacePath(value.targetWorkspacePath)
    ?? normalizeWorkspacePath(fallbacks.targetWorkspacePath);
  if (targetWorkspacePath) binding.targetWorkspacePath = targetWorkspacePath;
  const baseCommit = normalizeOptionalName(value.baseCommit) ?? normalizeOptionalName(fallbacks.baseCommit);
  if (baseCommit) binding.baseCommit = baseCommit;
  const taskBranch = normalizeOptionalName(value.taskBranch);
  if (taskBranch) binding.taskBranch = taskBranch;
  const worktreePath = normalizeWorkspacePath(value.worktreePath);
  if (worktreePath) binding.worktreePath = worktreePath;
  return binding;
}

export function normalizeRunnerState(runner, planId) {
  if (!runner || typeof runner !== 'object') return undefined;
  const now = new Date().toISOString();
  const status = RUNNER_STATUSES.has(runner.status) ? runner.status : 'idle';
  const next = {
    enabled: Boolean(runner.enabled),
    status,
    turnCount: Number.isFinite(runner.turnCount) ? Math.max(0, Math.trunc(runner.turnCount)) : 0,
    roundCount: Number.isFinite(runner.roundCount) ? Math.max(0, Math.trunc(runner.roundCount)) : 0,
    toolCallCount: Number.isFinite(runner.toolCallCount) ? Math.max(0, Math.trunc(runner.toolCallCount)) : 0,
    explorerCount: Number.isFinite(runner.explorerCount) ? Math.max(0, Math.trunc(runner.explorerCount)) : 0,
    maxTurns: Number.isFinite(runner.maxTurns) ? Math.max(1, Math.trunc(runner.maxTurns)) : 8,
    maxToolCalls: Number.isFinite(runner.maxToolCalls) ? Math.max(1, Math.trunc(runner.maxToolCalls)) : 40,
    maxExplorers: Number.isFinite(runner.maxExplorers)
      ? Math.min(MAX_EXPLORERS_HARD_CAP, Math.max(0, Math.trunc(runner.maxExplorers)))
      : 3,
    explorerConcurrency: Number.isFinite(runner.explorerConcurrency)
      ? Math.min(EXPLORER_CONCURRENCY_HARD_CAP, Math.max(1, Math.trunc(runner.explorerConcurrency)))
      : DEFAULT_EXPLORER_CONCURRENCY,
    updatedAt: typeof runner.updatedAt === 'string' && runner.updatedAt.trim() ? runner.updatedAt : now,
  };
  if (RUNNER_INTENTS.has(runner.intent)) {
    next.intent = runner.intent;
  }
  // Preserve malformed metadata for fail-closed validation at the continuation
  // seam. Dropping it here could silently create a fresh execution allowance.
  if (runner.verificationContinuation !== undefined) next.verificationContinuation = structuredClone(runner.verificationContinuation);
  if (GOAL_RUNNER_PHASES.has(runner.phase)) {
    next.phase = runner.phase;
  }
  if (typeof runner.currentTaskId === 'string' && runner.currentTaskId.trim()) {
    next.currentTaskId = runner.currentTaskId.trim();
  }
  if (typeof runner.runId === 'string' && runner.runId.trim()) {
    next.runId = runner.runId.trim();
  }
  if (runner.interruption && typeof runner.interruption === 'object') {
    const source = typeof runner.interruption.source === 'string'
      ? runner.interruption.source.trim()
      : '';
    const reason = typeof runner.interruption.reason === 'string'
      ? runner.interruption.reason.trim()
      : '';
    const interruptedAt = typeof runner.interruption.interruptedAt === 'string'
      ? runner.interruption.interruptedAt.trim()
      : '';
    if (source && reason && interruptedAt) {
      next.interruption = {
        source,
        origin: ['user', 'provider', 'host_handoff', 'lease_loss', 'tool', 'budget', 'unknown'].includes(runner.interruption.origin)
          ? runner.interruption.origin : ['runGoalTurn', 'stream_error'].includes(source) ? 'provider' : 'unknown',
        reason,
        interruptedAt,
        recoverable: runner.interruption.recoverable === true,
        attempt: Number.isFinite(runner.interruption.attempt)
          ? Math.max(1, Math.trunc(runner.interruption.attempt))
          : 1,
      };
    }
  }
  if (Number.isFinite(runner.recoverableInterruptionCount)) {
    next.recoverableInterruptionCount = Math.max(0, Math.trunc(runner.recoverableInterruptionCount));
  }
  if (Number.isFinite(runner.maxRecoverableInterruptionRetries)) {
    next.maxRecoverableInterruptionRetries = Math.max(0, Math.trunc(runner.maxRecoverableInterruptionRetries));
  }
  if (Number.isFinite(runner.compactionCount)) {
    next.compactionCount = Math.max(0, Math.trunc(runner.compactionCount));
  }
  if (typeof runner.lastCompactionAt === 'string' && runner.lastCompactionAt.trim()) {
    next.lastCompactionAt = runner.lastCompactionAt.trim();
  }
  if (typeof runner.lastConsumedCheckpointId === 'string' && runner.lastConsumedCheckpointId.trim()) {
    next.lastConsumedCheckpointId = runner.lastConsumedCheckpointId.trim();
  }
  if (Number.isFinite(runner.lastConsumedCheckpointSequence)) {
    next.lastConsumedCheckpointSequence = Math.max(0, Math.trunc(runner.lastConsumedCheckpointSequence));
  }
  if (runner.contextCheckpoint && typeof runner.contextCheckpoint === 'object') {
    try {
      next.contextCheckpoint = normalizeGoalCheckpoint(runner.contextCheckpoint, {
        fallbackPlanId: planId,
        fallbackRunId: next.runId || planId,
        now,
      });
    } catch {
      // Keep raw invalid checkpoint out of runtime state; recovery paths rebuild it.
    }
  }
  if (runner.blockerAudit && typeof runner.blockerAudit === 'object') {
    const fingerprint = typeof runner.blockerAudit.fingerprint === 'string'
      ? runner.blockerAudit.fingerprint.trim()
      : '';
    const reason = typeof runner.blockerAudit.reason === 'string'
      ? runner.blockerAudit.reason.trim()
      : '';
    if (fingerprint && reason) {
      next.blockerAudit = {
        fingerprint,
        reason,
        occurrences: Number.isFinite(runner.blockerAudit.occurrences)
          ? Math.max(1, Math.trunc(runner.blockerAudit.occurrences))
          : 1,
        firstSeenAt: typeof runner.blockerAudit.firstSeenAt === 'string' && runner.blockerAudit.firstSeenAt.trim()
          ? runner.blockerAudit.firstSeenAt.trim()
          : now,
        lastSeenAt: typeof runner.blockerAudit.lastSeenAt === 'string' && runner.blockerAudit.lastSeenAt.trim()
          ? runner.blockerAudit.lastSeenAt.trim()
          : now,
      };
    }
  }
  if (Number.isFinite(runner.tokenBudget)) {
    next.tokenBudget = Math.max(0, Math.trunc(runner.tokenBudget));
  }
  if (Number.isFinite(runner.tokenUsed)) {
    next.tokenUsed = Math.max(0, Math.trunc(runner.tokenUsed));
  }
  if (typeof runner.blockedReason === 'string' && runner.blockedReason.trim()) {
    next.blockedReason = runner.blockedReason.trim();
  }
  // 「在等真人」是独立事实，不能靠 blockedReason 的某个字面量来代表：
  // 具体原因（例如宽限后请求澄清）必须原样保留，同时消费者仍要能识别「是在等人」。
  if (runner.waitingOnUser === true) {
    next.waitingOnUser = true;
  }
  if (Array.isArray(runner.explorers)) {
    const explorers = runner.explorers
      .map((run) => normalizeExplorerRun(run, { planId }))
      .filter(Boolean);
    if (explorers.length > 0) next.explorers = explorers;
  }
  if (Array.isArray(runner.verifierRuns)) {
    const verifierRuns = runner.verifierRuns
      .map((run) => normalizeVerifierRun(run, { planId }))
      .filter(Boolean);
    if (verifierRuns.length > 0) next.verifierRuns = verifierRuns;
  }
  if (runner.explorerBatch && typeof runner.explorerBatch === 'object') {
    const batchId = typeof runner.explorerBatch.batchId === 'string' && runner.explorerBatch.batchId.trim()
      ? runner.explorerBatch.batchId.trim()
      : undefined;
    const total = Number.isFinite(runner.explorerBatch.total)
      ? Math.max(0, Math.trunc(runner.explorerBatch.total))
      : 0;
    const done = Number.isFinite(runner.explorerBatch.done)
      ? Math.max(0, Math.min(total, Math.trunc(runner.explorerBatch.done)))
      : 0;
    if (batchId && total > 0) {
      next.explorerBatch = { batchId, total, done };
    }
  }
  const inspectPlan = normalizeExplorePlan(runner.inspectPlan);
  if (inspectPlan) next.inspectPlan = inspectPlan;
  if (typeof runner.lastError === 'string' && runner.lastError.trim()) {
    next.lastError = runner.lastError.trim();
  }
  if (runner.visualRepair === null) {
    // Explicit clear: do not keep a previous host-normalized repair brief.
  } else {
    const visualRepair = normalizeVisualRepair(runner.visualRepair);
    if (visualRepair) next.visualRepair = visualRepair;
  }
  return next;
}

const DELEGATION_SURFACES = new Set(['desktop', 'quick_chat', 'tui', 'remote']);

const DELEGATION_PHASES = new Set(['running', 'queued', 'awaiting_approval', 'paused', 'superseded']);

const MODEL_SELECTION_SOURCES = new Set([
  'this_request', 'task', 'objective', 'project', 'global', 'auto',
]);

function normalizeRuntimeModelSelection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const providerId = normalizeOptionalString(value.providerId);
  const modelId = normalizeOptionalString(value.modelId);
  const modelProviderId = normalizeOptionalString(value.modelProviderId);
  const family = normalizeOptionalString(value.family);
  if (!providerId || !modelId || !modelProviderId || !family) return null;
  const selection = { providerId, modelId, modelProviderId, family };
  const reasoningEffort = normalizeOptionalString(value.reasoningEffort);
  if (reasoningEffort) selection.reasoningEffort = reasoningEffort;
  if (typeof value.fastMode === 'boolean') selection.fastMode = value.fastMode;
  return selection;
}

function normalizeModelSelectionSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const worker = normalizeRuntimeModelSelection(value.worker);
  const explorer = normalizeRuntimeModelSelection(value.explorer);
  const verifier = normalizeRuntimeModelSelection(value.verifier);
  if (!worker || !explorer || !verifier) return null;
  const resolvedAt = normalizeOptionalString(value.resolvedAt);
  if (!resolvedAt) return null;
  const source = {};
  if (value.source && typeof value.source === 'object' && !Array.isArray(value.source)) {
    for (const [key, item] of Object.entries(value.source)) {
      if (MODEL_SELECTION_SOURCES.has(item)) source[key] = item;
    }
  }
  const snapshot = {
    worker,
    explorer,
    verifier: { ...verifier, sameFamilyAsWorker: value.verifier.sameFamilyAsWorker === true },
    source,
    resolvedAt,
  };
  const visualVerifier = normalizeRuntimeModelSelection(value.visualVerifier);
  if (visualVerifier) snapshot.visualVerifier = visualVerifier;
  const autoReason = normalizeOptionalString(value.autoReason);
  if (autoReason) snapshot.autoReason = autoReason;
  return snapshot;
}

/**
 * 任务来源。协议字段必填；workspaceId / sessionId / readOnly / phase 等是运行时回读所需。
 * memorySnapshotId 在 B2-10 之前允许为 null。非法形状整段丢弃，避免半截来源进入计划。
 */
function normalizeCapabilityAdmission(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !Array.isArray(value.required) || !value.required.every(id => typeof id === 'string' && id.trim())
    || typeof value.inventoryKnown !== 'boolean' || typeof value.requirementsDeclared !== 'boolean'
    || !(value.inventoryHash === null || typeof value.inventoryHash === 'string' && value.inventoryHash.trim())
    || !toIsoOrNull(value.checkedAt)) return null;
  return {
    required: [...new Set(value.required.map(id => id.trim()))],
    inventoryHash: value.inventoryHash === null ? null : value.inventoryHash.trim(),
    inventoryKnown: value.inventoryKnown,
    requirementsDeclared: value.requirementsDeclared,
    checkedAt: toIsoOrNull(value.checkedAt),
  };
}

export function normalizeDelegationOrigin(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const anchorMessageId = normalizeOptionalString(value.anchorMessageId);
  const inputId = normalizeOptionalString(value.inputId);
  const modelSelection = normalizeModelSelectionSnapshot(value.modelSelection);
  if (!anchorMessageId || !inputId || !modelSelection) return null;
  const origin = {
    anchorMessageId,
    inputId,
    surface: DELEGATION_SURFACES.has(value.surface) ? value.surface : 'desktop',
    memorySnapshotId: normalizeOptionalString(value.memorySnapshotId),
    modelSelection,
    depth: Number.isInteger(value.depth) && value.depth >= 0 ? value.depth : 1,
  };
  for (const key of [
    'workspaceId', 'sessionId', 'workId', 'parentSessionId', 'objectiveId', 'objectiveActionId',
    'idempotencyKey', 'parentConversationId', 'supersededBy', 'lastResumeAnchorMessageId',
    'agentWaitMessageId', 'agentResumePending',
  ]) {
    const text = normalizeOptionalString(value[key]);
    if (text) origin[key] = text;
  }
  const capabilityAdmission = normalizeCapabilityAdmission(value.capabilityAdmission);
  if (capabilityAdmission) origin.capabilityAdmission = capabilityAdmission;
  if (value.readOnly === true || value.readOnly === false) origin.readOnly = value.readOnly;
  if (value.verifying === true) origin.verifying = true;
  if (value.cancellation && typeof value.cancellation.operationId === 'string'
    && ['stopping', 'awaiting_outcome', 'completed'].includes(value.cancellation.phase)) origin.cancellation = structuredClone(value.cancellation);
  if (value.takeover && typeof value.takeover.operationId === 'string'
    && ['stopping', 'completed'].includes(value.takeover.phase)) origin.takeover = structuredClone(value.takeover);
  if (value.coordinationBinding && typeof value.coordinationBinding.workId === 'string'
    && Number.isSafeInteger(value.coordinationBinding.goalRevision) && typeof value.coordinationBinding.executionEpoch === 'string') origin.coordinationBinding = structuredClone(value.coordinationBinding);
  if (DELEGATION_PHASES.has(value.phase)) origin.phase = value.phase;
  if (['running', 'queued', 'awaiting_approval'].includes(value.pausedFromPhase)) origin.pausedFromPhase = value.pausedFromPhase;
  if (['execute', 'explore', 'verify', 'synthesize', 'block'].includes(value.pausedRunnerIntent)) origin.pausedRunnerIntent = value.pausedRunnerIntent;
  if (['high', 'normal', 'low'].includes(value.priority)) origin.priority = value.priority;
  if (['auto', 'none', 'worktree'].includes(value.isolation)) origin.isolation = value.isolation;
  if (['disk_space', 'isolation_failed'].includes(value.isolationBlock)) origin.isolationBlock = value.isolationBlock;
  const isolationRetainedAt = toIsoOrNull(value.isolationRetainedAt);
  if (isolationRetainedAt) origin.isolationRetainedAt = isolationRetainedAt;
  if (value.retainedForRecovery === true) origin.retainedForRecovery = true;
  for (const key of ['handoffAuthorizedAt', 'handoffDeferredAt', 'supersededAt']) {
    const at = toIsoOrNull(value[key]);
    if (at) origin[key] = at;
  }
  if (Array.isArray(value.dependsOn)) {
    const dependsOn = value.dependsOn
      .filter((item) => typeof item === 'string' && item.trim())
      .map((item) => item.trim())
      .slice(0, 8);
    if (dependsOn.length > 0) origin.dependsOn = dependsOn;
  }
  return origin;
}

function normalizeResultAcceptance(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const acceptedAt = normalizeOptionalString(value.acceptedAt);
  if (!acceptedAt) return null;
  const record = { acceptedAt };
  const acceptedBy = normalizeOptionalString(value.acceptedBy);
  if (acceptedBy) record.acceptedBy = acceptedBy;
  if (value.userOverride === true) record.userOverride = true;
  const verdictRef = normalizeOptionalString(value.verdictRef);
  if (verdictRef) record.verdictRef = verdictRef;
  return record;
}

export function normalizePlan(plan) {
  if (!plan) return null;
  const normalizedConversationId = normalizeConversationId(plan.conversationId);
  const approvalDecision = plan.approval?.decision;
  const normalizedStatus = approvalDecision === 'reject' && plan.status !== 'cancelled'
    ? 'cancelled'
    : plan.status;
  const workflowKind = normalizeWorkflowKind(plan.workflowKind);
  const normalized = {
    ...plan,
    conversationId: normalizedConversationId ?? undefined,
    originWorkspacePath: normalizeWorkspacePath(plan.originWorkspacePath) ?? undefined,
    targetWorkspacePath: normalizeWorkspacePath(plan.targetWorkspacePath) ?? undefined,
    targetRepoId: normalizeOptionalName(plan.targetRepoId) ?? normalizeOptionalName(plan.deliveryBinding?.repoId),
    targetBranch: normalizeOptionalName(plan.targetBranch) ?? normalizeOptionalName(plan.deliveryBinding?.targetBranch),
    baseCommit: normalizeOptionalName(plan.baseCommit) ?? normalizeOptionalName(plan.deliveryBinding?.baseCommit),
    targetBranchSource: normalizeTargetBranchSource(plan.targetBranchSource)
      ?? normalizeTargetBranchSource(plan.deliveryBinding?.targetBranchSource),
    deliveryBinding: normalizeDeliveryBinding(plan.deliveryBinding, {
      targetWorkspacePath: plan.targetWorkspacePath,
      baseCommit: plan.baseCommit,
    }),
    workflowKind,
    activation: normalizeActivation(plan.activation, workflowKind, normalizedStatus),
    executionPolicy: normalizeExecutionPolicy(plan.executionPolicy, workflowKind),
    status: normalizedStatus,
    // 读路径降级：存量计划的 successCriteria 可能是纯字符串数组或缺字段，
    // 统一归一为结构化 SuccessCriterion[]；criterionResults 缺失时补空数组。
    // 不破坏旧计划，保证下游（完成门 / 提示词渲染）拿到一致形态。
    successCriteria: normalizeSuccessCriteria(plan.successCriteria),
    criterionResults: normalizeCriterionResults(plan.criterionResults),
    manualConfirmations: normalizeManualConfirmations(plan.manualConfirmations),
    qualityReview: normalizeQualityReview(plan.qualityReview),
    deliveryHandoff: normalizeDeliveryHandoff(plan.deliveryHandoff),
  };
  const resultAcceptance = normalizeResultAcceptance(plan.resultAcceptance);
  if (resultAcceptance) normalized.resultAcceptance = resultAcceptance;
  else delete normalized.resultAcceptance;
  const delegationOrigin = normalizeDelegationOrigin(plan.delegationOrigin);
  if (delegationOrigin) normalized.delegationOrigin = delegationOrigin;
  else delete normalized.delegationOrigin;
  const runner = normalizeRunnerState(plan.runner, plan.planId);
  // 读路径只恢复「叶子已全部成功，但计划仍钉在 failed、且没有未消费中断」的过期记录。
  // 仍有 runner.interruption 时保持挂起：最后一片叶子 completed 不得把可恢复中断洗成 completed。
  // 不能对所有状态全量派生，否则 completed intake 被 markRequestedUserInput
  // 重新打开后，读盘会立刻打回 completed。
  if (normalized.status === 'interrupted' || normalized.status === 'failed') {
    const derivedStatus = derivePlanStatus(normalized.status, plan.tasks);
    if (derivedStatus === TERMINAL_OK) {
      const hasUnconsumedInterruption = Boolean(
        runner?.interruption &&
        !(runner.interruption.recoverable === true && runner.status === 'running'),
      );
      if (!hasUnconsumedInterruption) {
        normalized.status = derivedStatus;
      }
    }
  }
  const runTrace = normalizeRunTrace(plan.runTrace, { goalPlanId: plan.planId });
  const timing = normalizeGoalTiming(plan.timing);
  const withTiming = timing ? { ...normalized, timing } : normalized;
  const withRunTrace = runTrace.events.length > 0
    || runTrace.activeNodeId
    || runTrace.lastCheckpointNodeId
    ? { ...withTiming, runTrace }
    : withTiming;
  return { ...withRunTrace, ...(runner ? { runner } : {}), modelReviewSourceRevision: criterionSourceRevision(withRunTrace) };
}

/**
 * 叶子任务的「只剩等用户」判定：计划里已经没有 Agent 自己能推进的活。
 *
 * 背景：模型可以只把某个叶子标成 waiting_user（goal_update_task）而不调
 * request_user_input。这条路径过去只写任务、不写 runner，导致泵继续排轮，
 * 用户会看到「说要等你操作，下一轮又自己开跑」。停机与自动开跑闸门都必须
 * 复用同一个判定，避免两处语义漂移。
 *
 * 规则（只看叶子，即无 subtasks 的任务）：
 * - 终态叶子（completed / failed / cancelled）已收口，不构成阻塞。
 * - 叶子 waiting_user → 等用户。
 * - 叶子 running → Agent 还能自己推进，返回 false。
 * - 其他非终态（pending / queued 等）→ 还有没派下去的活，返回 false（宁可继续跑）。
 *
 * @param {object|null|undefined} plan
 * @returns {boolean} true 表示「有叶子在等用户，且没有别的可推进活」
 */
export function goalPlanWaitsOnUser(plan) {
  const roots = Array.isArray(plan?.tasks) ? plan.tasks : [];
  let leafCount = 0;
  let waitingLeafCount = 0;
  const stack = [...roots];
  while (stack.length > 0) {
    const task = stack.pop();
    if (!task || typeof task !== 'object') continue;
    const subtasks = Array.isArray(task.subtasks) ? task.subtasks : [];
    if (subtasks.length > 0) {
      for (const child of subtasks) stack.push(child);
      continue;
    }
    leafCount += 1;
    if (isPreviewReviewPendingLeaf(task)) continue;
    if (task.status === BLOCKED) {
      waitingLeafCount += 1;
    } else if (!LEAF_TERMINAL_STATUSES.has(task.status)) {
      return false;
    }
  }
  return leafCount > 0 && waitingLeafCount > 0;
}

// 「是否在等真人」是独立事实：新计划读显式标志位，旧计划回退到历史字面量。
// 这样具体原因（宽限后请求澄清等）可以原样保留，而消费者不必再猜字符串。
export function runnerWaitsOnUser(runner) {
  if (!runner || typeof runner !== 'object') return false;
  return runner.waitingOnUser === true || runner.blockedReason === 'requested_user_input';
}

export function goalPlanWaitsOnPreviewReview(plan) {
  if (plan?.runner?.status === BLOCKED && runnerWaitsOnUser(plan.runner)) return false;
  const roots = Array.isArray(plan?.tasks) ? plan.tasks : [];
  let pending = 0;
  const stack = [...roots];
  while (stack.length > 0) {
    const task = stack.pop();
    if (!task || typeof task !== 'object') continue;
    const subtasks = Array.isArray(task.subtasks) ? task.subtasks : [];
    if (subtasks.length > 0) {
      for (const child of subtasks) stack.push(child);
      continue;
    }
    if (isPreviewReviewPendingLeaf(task)) pending += 1;
    else if (!LEAF_TERMINAL_STATUSES.has(task.status)) return false;
  }
  return pending > 0;
}

/**
 * 用户回复可以消费 request_user_input 的计划态。
 * accepted + waiting_user 会出现在 intake 流错误残留、再被 goal_create_plan
 * 升成 accepted_goal 之后；只认 executing 会让「继续」永远吃不到回复。
 * interrupted + waiting_user 是流错误打断（可恢复重试耗尽）后 runner 停在
 * 等验收的残留态：不认 interrupted 的话，用户在输入框的每条回复都只被
 * message_routed 归档，runner 永远等不到验收答复（死锁，PeerAgent 空回复排查）。
 */
export function canConsumeRequestedUserInput(plan) {
  if (!plan) return false;
  if (plan.status !== 'executing' && plan.status !== 'accepted' && plan.status !== 'interrupted') return false;
  return ['waiting_user', 'blocked'].includes(plan.runner?.status)
    && runnerWaitsOnUser(plan.runner);
}

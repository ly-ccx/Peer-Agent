import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  renameSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathOf } from './data-store.mjs';

/**
 * Goal 计划持久化 store —— 见 Goal 模式设计。
 *
 * 设计要点（与提案 §3/§4/§6 一致）：
 * - 计划是持久化的 Evidence/artifact，目录型多记录：index.jsonl（轻量元信息，
 *   用于列表）+ 每个计划一个 `${planId}.json`（全量 GoalPlan）。
 * - 原子写：先写 `.tmp` 再 rename，避免半截文件损坏。
 * - 子任务（含嵌套）状态只能由 Evidence 回写；置为 'completed' 必须带 evidenceRefs。
 * - progress 由子任务自底向上聚合，调用方不可手填（每次写入都会重算覆盖）。
 *
 * 协议类型见 packages/protocol/src/goal.ts。本模块只依赖 fs/path/crypto，
 * 不 import electron，可被单测直接 import。
 */

// maxExplorers 的硬上限护栏。历史语义为「每计划累计可派发 Explorer 总数」，现已弃用
// （不再作为累计闸），仅为兼容旧持久化数据保留字段。此上限继续对异常值做对称钳制。
const MAX_EXPLORERS_HARD_CAP = 10;

// explorerConcurrency 的硬上限护栏。每个 explorer 是一个完整的只读子 Agent loop，
// 直接是 token / 时间成本的乘数。并发上限可经外部（IPC options / runner 状态）传入，
// 此处补一个对称的上限挡住异常值（例如某轮请求几十个时把限流打爆）；默认 5 远低于上限。
const EXPLORER_CONCURRENCY_HARD_CAP = 8;
const DEFAULT_EXPLORER_CONCURRENCY = 5;

function readJsonl(filePath) {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function appendJsonl(filePath, obj) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  appendFileSync(filePath, JSON.stringify(obj) + '\n', 'utf8');
}

function writeJsonl(filePath, items) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, items.map((item) => JSON.stringify(item)).join('\n') + '\n', 'utf8');
  renameSync(tmp, filePath);
}

function writeJsonAtomic(filePath, obj) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  renameSync(tmp, filePath);
}

function readJson(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/** ExecutionStatus（execution.ts）——本 store 仅依赖这些字面量做聚合判定。 */
const TERMINAL_OK = 'completed';
const TERMINAL_FAIL = 'failed';
const BLOCKED = 'waiting_user';

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

/**
 * 由子任务事实自底向上派生「计划整体状态」，与 aggregateProgress 同源（提案 §4/§6）。
 *
 * 规则：
 *
 * 1. 开工推进：当计划已处于「已批准」状态（approved），
 *    但已有任意子任务进入活跃或终态（running / completed / failed / waiting_user）时，
 *    说明执行已经开始，此时把计划推进到 'executing'，从而让审批相关 UI 正确收敛。
 *    注意：'awaiting_approval'（未批准）不在此规则的推进范围内——未批准计划即便
 *    出现活跃叶子，也不会被派生成 'executing'，以杜绝「顶层 executing 但从未批准、
 *    Runner 未启动」的僵死态。批准闸门只能由显式 recordApproval 打开。
 *
 * 2. 自动收尾：当计划已 'executing'（或可恢复的 'failed'）且存在叶子、且所有叶子均为
 *    终态（completed / failed）时，把顶层推进到终态——含任一 failed → 'failed'，
 *    否则全 completed → 'completed'。waiting_user 不算终态；空计划不收尾。
 *
 * 3. 失败恢复：stream/runtime 中断可能把 plan 显式标成 'failed'，但子任务仍可能继续
 *    成功完成。若全部叶子已成功终态，则收尾为 'completed'（解除 failed 粘住）。
 *    未全部终态时保持 'failed'；继续执行需 resumeRunner / 用户续聊显式恢复为 executing。
 *    历史失败事件仍保留在 runTrace，不因状态恢复而抹掉。
 *
 * cancelled / paused / drafting 等显式态不由此函数回退改写。
 *
 * @param {string} currentStatus 当前 plan.status
 * @param {Array} tasks 顶层子任务树
 * @returns {string} 派生后的 plan.status
 */
export function derivePlanStatus(currentStatus, tasks) {
  const inspectLeaves = (list) => {
    let leafTotal = 0;
    let allTerminal = true;
    let hasFailed = false;
    const walkLeaves = (nodes) => {
      for (const t of nodes || []) {
        const children = Array.isArray(t.subtasks) ? t.subtasks : [];
        if (children.length > 0) {
          walkLeaves(children);
          continue;
        }
        leafTotal += 1;
        if (t.status === TERMINAL_FAIL) hasFailed = true;
        else if (t.status !== TERMINAL_OK) allTerminal = false;
      }
    };
    walkLeaves(list);
    return { leafTotal, allTerminal, hasFailed };
  };

  // 规则 2/3：executing 自动收尾；failed 仅在「叶子事实已全部成功完成」时恢复为 completed，
  // 避免 stream_error 把计划永久粘在 failed。未全部终态时保持 failed（需 resumeRunner
  // 显式恢复为 executing，或等全部叶子成功后自动 completed）。
  if (currentStatus === 'executing' || currentStatus === 'failed') {
    const { leafTotal, allTerminal, hasFailed } = inspectLeaves(tasks);
    if (leafTotal > 0 && allTerminal) {
      return hasFailed ? TERMINAL_FAIL : TERMINAL_OK;
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

/**
 * 在任务树里按 taskId 定位并以 updater 产生的新对象替换（不可变更新）。
 * @returns {{tasks:Array, found:boolean}}
 */
function updateTaskInTree(tasks, taskId, updater) {
  let found = false;
  const map = (list) =>
    (list || []).map((t) => {
      if (t.taskId === taskId) {
        found = true;
        return updater(t);
      }
      if (Array.isArray(t.subtasks) && t.subtasks.length > 0) {
        const next = map(t.subtasks);
        return { ...t, subtasks: next };
      }
      return t;
    });
  const next = map(tasks);
  return { tasks: next, found };
}

function taskExistsInTree(tasks, taskId) {
  if (!taskId) return false;
  const stack = Array.isArray(tasks) ? [...tasks] : [];
  while (stack.length > 0) {
    const task = stack.shift();
    if (!task || typeof task !== 'object') continue;
    if (task.taskId === taskId) return true;
    if (Array.isArray(task.subtasks)) {
      for (const child of task.subtasks) stack.push(child);
    }
  }
  return false;
}

function findTaskInTree(tasks, taskId) {
  if (!taskId) return null;
  const stack = Array.isArray(tasks) ? [...tasks] : [];
  while (stack.length > 0) {
    const task = stack.shift();
    if (!task || typeof task !== 'object') continue;
    if (task.taskId === taskId) return task;
    if (Array.isArray(task.subtasks)) {
      for (const child of task.subtasks) stack.push(child);
    }
  }
  return null;
}

const RUNNER_STATUSES = new Set([
  'idle',
  'running',
  'paused',
  'exploring',
  'blocked',
  'budget_exhausted',
  'completed',
  'failed',
]);
const RUNNER_INTENTS = new Set(['execute', 'verify', 'explore', 'synthesize', 'block']);
const EXPLORER_STATUSES = new Set(['queued', 'running', 'completed', 'failed', 'cancelled']);
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
const CONFIRMATION_DECISIONS = new Set(['approve', 'reject', 'revise']);
const MANUAL_CONFIRMATION_KINDS = new Set(['manual_dod']);
const GOAL_RUNNER_PHASES = new Set([
  'orient',
  'inspect',
  'plan_scaffold',
  'act',
  'verify',
  'repair',
  'synthesize',
  'blocked',
]);
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

const DEFAULT_SELF_DRIVEN_POLICY = Object.freeze({
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

function normalizeStringArray(value) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim())
    : [];
}

function normalizeOptionalString(value) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeEvidenceRefList(value) {
  if (typeof value === 'string') return normalizeStringArray([value]);
  return normalizeStringArray(value);
}

function normalizeEvidenceIndexRecord(value) {
  if (!value || typeof value !== 'object') return null;
  const evidenceRef = normalizeOptionalString(value.evidenceRef);
  if (!evidenceRef) return null;
  const createdAt = normalizeOptionalString(value.createdAt) || new Date().toISOString();
  const record = { evidenceRef, createdAt };
  const optionalFields = [
    'planId',
    'conversationId',
    'streamId',
    'toolCallId',
    'capabilityId',
    'toolName',
  ];
  for (const field of optionalFields) {
    const normalized = normalizeOptionalString(value[field]);
    if (normalized) record[field] = normalized;
  }
  const artifactRefs = normalizeEvidenceRefList(value.artifactRefs);
  if (artifactRefs.length > 0) record.artifactRefs = artifactRefs;
  return record;
}

function normalizeWorkflowKind(value) {
  return WORKFLOW_KINDS.has(value) ? value : 'plan_approval';
}

function isSelfDrivenGoal(plan) {
  return plan?.workflowKind === 'goal_self_driven'
    || plan?.executionPolicy?.autonomy === 'self_driven'
    || plan?.activation?.kind === 'accepted_goal';
}

export function goalPlanIsSelfDriven(plan) {
  return isSelfDrivenGoal(plan);
}

export function goalPlanRequiresApproval(plan) {
  return !isSelfDrivenGoal(plan);
}

function defaultExecutionPolicyForWorkflow(workflowKind) {
  return workflowKind === 'goal_self_driven'
    ? DEFAULT_SELF_DRIVEN_POLICY
    : DEFAULT_APPROVAL_GATED_POLICY;
}

function normalizeActivation(value, workflowKind, status) {
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

function normalizeExecutionPolicy(value, workflowKind) {
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

function makeDefaultGoalTask(goal) {
  return {
    taskId: 'orient',
    order: 0,
    title: goal
      ? '理清目标，拆出能验收的小步骤'
      : '理清目标',
    path: [],
    dependsOn: [],
    acceptanceCriteria: [],
    involvedFiles: [],
    status: 'pending',
    evidenceRefs: [],
  };
}

// 成功标准（DoD）的可选类型。command/test/file-contains/file-exists 可被机器自动
// 验证；manual 需人工确认。见 goal-mode-ultrathink-workflow 设计文档「DoD-as-Code」。
const CRITERION_KINDS = new Set(['command', 'test', 'file-contains', 'file-exists', 'manual']);
// 可自动验证的标准类型（完成门要求带 passed=true 的 CriterionResult）。
const AUTO_CRITERION_KINDS = new Set(['command', 'test', 'file-contains', 'file-exists']);

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
  if (command) criterion.command = command;
  if (targetPath) criterion.path = targetPath;
  if (expect) criterion.expect = expect;
  return criterion;
}

function normalizeSuccessCriteria(value) {
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

function normalizeCriterionResults(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => normalizeCriterionResult(item)).filter(Boolean);
}

function normalizeManualConfirmation(value) {
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

function normalizeManualConfirmations(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => normalizeManualConfirmation(item)).filter(Boolean);
}

function collectManualCriterionIds(plan) {
  return (Array.isArray(plan?.successCriteria) ? plan.successCriteria : [])
    .filter((criterion) => criterion && typeof criterion === 'object')
    .filter((criterion) => !AUTO_CRITERION_KINDS.has(criterion.kind))
    .map((criterion) => (typeof criterion.id === 'string' ? criterion.id.trim() : ''))
    .filter(Boolean);
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

function normalizeExplorerReport(report, fallback = {}) {
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

function collectExplorerReportEvidenceRefs(report) {
  const refs = new Set();
  for (const ref of normalizeStringArray(report?.evidenceRefs)) refs.add(ref);
  for (const finding of Array.isArray(report?.findings) ? report.findings : []) {
    for (const ref of normalizeStringArray(finding?.evidenceRefs)) refs.add(ref);
  }
  return Array.from(refs);
}

function normalizeExplorerRegistryRefs(report, existingRun = {}) {
  const explicit =
    report?.allowedEvidenceRefs ??
    report?.registeredEvidenceRefs ??
    report?.toolEvidenceRefs ??
    report?.evidenceRegistry;
  const refs = explicit !== undefined ? explicit : existingRun.evidenceRefs;
  return normalizeStringArray(refs);
}

function assertExplorerReportEvidenceRegistered({ explorerId, report, registeredRefs }) {
  if (!report || report.evidenceRefs.length === 0) {
    throw new Error(
      `[goal-plan-store] explorer ${explorerId} cannot be 'completed' without evidenceRefs`,
    );
  }
  if (registeredRefs.length === 0) {
    throw new Error(
      `[goal-plan-store] explorer ${explorerId} cannot be 'completed' without registered tool evidenceRefs`,
    );
  }
  const registered = new Set(registeredRefs);
  const unknown = collectExplorerReportEvidenceRefs(report).filter((ref) => !registered.has(ref));
  if (unknown.length > 0) {
    throw new Error(
      `[goal-plan-store] explorer ${explorerId} reported unregistered evidenceRefs: ${unknown.join(', ')}`,
    );
  }
}

function normalizeExplorerRun(run, fallback = {}) {
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

function countExplorerRuns(explorers) {
  return Array.isArray(explorers) ? explorers.filter(Boolean).length : 0;
}

const EXPLORER_TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

// 依据某个 batchId，从 explorers 列表推导「本轮」并发进度：
// total = 属于该 batch 的 Explorer 总数（分母），done = 其中已进入终止态的数量（分子）。
// 幂等：dispatch / report 任意时刻调用都能得到与当前列表一致的进度。
function computeExplorerBatch(explorers, batchId) {
  if (!batchId) return undefined;
  const runs = (Array.isArray(explorers) ? explorers : []).filter(
    (run) => run && run.batchId === batchId,
  );
  if (runs.length === 0) return undefined;
  const done = runs.filter((run) => EXPLORER_TERMINAL_STATUSES.has(run.status)).length;
  return { batchId, total: runs.length, done };
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

function normalizeVerifierRun(run, fallback = {}) {
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

function normalizeRunEvent(event, fallback = {}) {
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

function normalizeRunTrace(trace, fallback = {}) {
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

const ACTIVE_PLAN_STATUSES = new Set(['drafting', 'awaiting_approval', 'approved', 'accepted', 'executing', 'paused', 'failed']);

function normalizeConversationId(value) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
}

// 目标要改动的代码仓绝对路径（可与会话工作区不同，例如"知识库驱动代码库"场景）。
// 归一化镜像 normalizeConversationId：trim 后空串归一为 null，供 Explorer 派发时注入。
function normalizeWorkspacePath(value) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeRunnerState(runner, planId) {
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
  if (GOAL_RUNNER_PHASES.has(runner.phase)) {
    next.phase = runner.phase;
  }
  if (typeof runner.currentTaskId === 'string' && runner.currentTaskId.trim()) {
    next.currentTaskId = runner.currentTaskId.trim();
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
  return next;
}

function normalizePlan(plan) {
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
  };
  const runner = normalizeRunnerState(plan.runner, plan.planId);
  const runTrace = normalizeRunTrace(plan.runTrace, { goalPlanId: plan.planId });
  const withRunTrace = runTrace.events.length > 0
    || runTrace.activeNodeId
    || runTrace.lastCheckpointNodeId
    ? { ...normalized, runTrace }
    : normalized;
  return runner ? { ...withRunTrace, runner } : withRunTrace;
}

function withRunTraceEvent(plan, event = {}) {
  if (!plan?.planId) return plan;
  const current = normalizeRunTrace(plan.runTrace, { goalPlanId: plan.planId });
  const normalizedEvent = normalizeRunEvent({
    ...event,
    goalPlanId: plan.planId,
    createdAt: event.createdAt || plan.updatedAt || new Date().toISOString(),
  }, { goalPlanId: plan.planId });
  if (!normalizedEvent) {
    return current.events.length > 0 || current.activeNodeId || current.lastCheckpointNodeId
      ? { ...plan, runTrace: current }
      : plan;
  }
  const nextTrace = {
    ...current,
    events: [...current.events, normalizedEvent],
  };
  const activeNodeId = normalizeOptionalString(event.activeNodeId) || normalizedEvent.nodeId;
  if (activeNodeId) nextTrace.activeNodeId = activeNodeId;
  if (normalizedEvent.type === 'checkpoint_created' && activeNodeId) {
    nextTrace.lastCheckpointNodeId = activeNodeId;
  }
  return { ...plan, runTrace: nextTrace };
}

function isActivePlan(plan) {
  return ACTIVE_PLAN_STATUSES.has(plan?.status);
}

function isInactivePlan(plan) {
  return plan?.status === 'cancelled';
}

export function createGoalPlanStore({ storeDir = pathOf('goalPlans'), onChange } = {}) {
  const indexFile = path.join(storeDir, 'index.jsonl');
  const evidenceIndexFile = path.join(storeDir, 'evidence-index.jsonl');

  // 变更通知 Seam：任何写操作（create/revise/approve/setStatus/recordTaskEvidence/delete）
  // 完成后触发 onChange，使 main 进程可向 renderer 广播 'goalPlans:changed'。
  // 收口于此，AI 工具路径（local-goal-provider）与 IPC 路径共享同一通知，
  // 无需在每个调用点重复挂广播。回调异常被吞掉，绝不影响写盘结果。
  //
  // payload 契约（向后兼容扩展）：
  // - reason: 写路径标签（persist/delete/...）
  // - planId / conversationId: 供 renderer 做会话域过滤
  // - changeKind: 变更分级（persist | delete | runner-progress | runner-state）
  // - runner: runner-progress 时附带最新 runner，便于 UI 本地 patch
  function notifyChanged(reason, planId, options = {}) {
    if (typeof onChange !== 'function') return;
    try {
      const conversationId =
        options.conversationId !== undefined
          ? options.conversationId ?? null
          : null;
      onChange({
        reason,
        planId: planId ?? null,
        conversationId,
        changeKind: options.changeKind ?? reason ?? 'persist',
        ...(options.runner ? { runner: options.runner } : {}),
      });
    } catch (err) {
      // 广播失败不影响写盘结果，但显式打印以便排查（不要静默吞）。
      console.warn('[goal-plan-store] onChange broadcast failed:', err);
    }
  }

  /** Runner 高频进度字段：仅计数/阶段跳动时走 runner-progress，避免无关会话全量 list。 */
  const RUNNER_PROGRESS_KEYS = new Set([
    'turnCount',
    'roundCount',
    'toolCallCount',
    'explorerCount',
    'updatedAt',
    'phase',
    'currentTaskId',
    'lastTickAt',
  ]);

  function classifyRunnerChangeKind(patch = {}) {
    const keys = Object.keys(patch).filter((key) => patch[key] !== undefined);
    if (keys.length === 0) return 'runner-state';
    return keys.every((key) => RUNNER_PROGRESS_KEYS.has(key))
      ? 'runner-progress'
      : 'runner-state';
  }

  // runner-progress 内存叠加 + 写盘节流：保证同 tick 内 getPlan 读到最新计数，
  // 同时把磁盘写入合并到 300ms 窗口，降低高频 tick 的 IO 与广播放大。
  const runnerProgressOverlay = new Map();
  const runnerProgressTimers = new Map();
  const RUNNER_PROGRESS_PERSIST_MS = 300;

  function clearRunnerProgressState(planId) {
    if (planId) {
      runnerProgressOverlay.delete(planId);
      const timer = runnerProgressTimers.get(planId);
      if (timer) {
        clearTimeout(timer);
        runnerProgressTimers.delete(planId);
      }
      return;
    }
    for (const timer of runnerProgressTimers.values()) clearTimeout(timer);
    runnerProgressTimers.clear();
    runnerProgressOverlay.clear();
  }

  function flushRunnerProgressPersist(planId, { notify = false } = {}) {
    const timer = runnerProgressTimers.get(planId);
    if (timer) {
      clearTimeout(timer);
      runnerProgressTimers.delete(planId);
    }
    const overlay = runnerProgressOverlay.get(planId);
    if (!overlay) return null;
    const normalized = normalizePlan(overlay);
    const next = {
      ...normalized,
      status: derivePlanStatus(normalized.status, normalized.tasks),
      progress: aggregateProgress(normalized.tasks),
    };
    writeJsonAtomic(planFile(next.planId), next);
    syncIndex(next);
    // 落盘后保留 overlay 内容一致；完整 persist 路径会清 overlay。
    runnerProgressOverlay.set(planId, next);
    if (notify) {
      notifyChanged('persist', next.planId, {
        conversationId: next.conversationId ?? null,
        changeKind: 'runner-progress',
        runner: next.runner ?? null,
      });
    }
    return next;
  }

  function scheduleRunnerProgressPersist(planId) {
    if (runnerProgressTimers.has(planId)) return;
    const timer = setTimeout(() => {
      runnerProgressTimers.delete(planId);
      flushRunnerProgressPersist(planId, { notify: false });
    }, RUNNER_PROGRESS_PERSIST_MS);
    runnerProgressTimers.set(planId, timer);
  }

  function planFile(id) {
    return path.join(storeDir, `${id}.json`);
  }

  function readIndex() {
    return readJsonl(indexFile);
  }

  function readEvidenceIndex() {
    return readJsonl(evidenceIndexFile)
      .map(normalizeEvidenceIndexRecord)
      .filter(Boolean);
  }

  function inferEvidencePlanId(planId, conversationId) {
    const normalizedPlanId = normalizeOptionalString(planId);
    if (normalizedPlanId) return normalizedPlanId;
    const normalizedConversationId = normalizeConversationId(conversationId);
    if (!normalizedConversationId) return null;
    return getActivePlanByConversation(normalizedConversationId)?.planId ?? null;
  }

  function recordEvidenceRefs(entry = {}) {
    const refs = normalizeEvidenceRefList(entry.evidenceRefs ?? entry.evidenceRef);
    if (refs.length === 0) return [];
    const conversationId = normalizeConversationId(entry.conversationId);
    const planId = inferEvidencePlanId(entry.planId, conversationId);
    const artifactRefs = normalizeEvidenceRefList(entry.artifactRefs);
    const createdAt = normalizeOptionalString(entry.createdAt) || new Date().toISOString();
    const base = { createdAt };
    if (planId) base.planId = planId;
    if (conversationId) base.conversationId = conversationId;
    for (const field of ['streamId', 'toolCallId', 'capabilityId', 'toolName']) {
      const normalized = normalizeOptionalString(entry[field]);
      if (normalized) base[field] = normalized;
    }
    if (artifactRefs.length > 0) base.artifactRefs = artifactRefs;
    const records = refs
      .map((evidenceRef) => normalizeEvidenceIndexRecord({ ...base, evidenceRef }))
      .filter(Boolean);
    for (const record of records) appendJsonl(evidenceIndexFile, record);
    return records;
  }

  function evidenceRecordMatchesPlan(record, plan) {
    if (!record || !plan) return false;
    if (record.planId && record.planId === plan.planId) return true;
    const planConversationId = normalizeConversationId(plan.conversationId);
    return Boolean(
      planConversationId
        && normalizeConversationId(record.conversationId) === planConversationId,
    );
  }

  function indexedEvidenceRefsForPlan(plan, refs) {
    const wanted = new Set(normalizeEvidenceRefList(refs));
    if (!plan || wanted.size === 0) return new Set();
    const found = new Set();
    for (const record of readEvidenceIndex()) {
      if (!wanted.has(record.evidenceRef)) continue;
      if (evidenceRecordMatchesPlan(record, plan)) found.add(record.evidenceRef);
    }
    return found;
  }

  function assertAnyEvidenceRefIndexed(plan, refs, context) {
    const normalizedRefs = normalizeEvidenceRefList(refs);
    if (normalizedRefs.length === 0) return;
    if (indexedEvidenceRefsForPlan(plan, normalizedRefs).size > 0) return;
    throw new Error(
      `[goal-plan-store] ${context} evidenceRefs are not registered in EvidenceIndex: ${normalizedRefs.join(', ')}`,
    );
  }

  function assertEvidenceRefIndexed(plan, ref, context) {
    const normalizedRef = normalizeOptionalString(ref);
    if (!normalizedRef) return;
    if (indexedEvidenceRefsForPlan(plan, [normalizedRef]).size > 0) return;
    throw new Error(
      `[goal-plan-store] ${context} evidenceRef is not registered in EvidenceIndex: ${normalizedRef}`,
    );
  }

  function toMeta(plan) {
    return {
      planId: plan.planId,
      title: plan.title,
      status: plan.status,
      workflowKind: plan.workflowKind,
      conversationId: plan.conversationId ?? null,
      threadId: plan.threadId ?? null,
      version: plan.version,
      percent: plan.progress?.percent ?? 0,
      createdAt: plan.createdAt,
      updatedAt: plan.updatedAt,
    };
  }

  function syncIndex(plan) {
    const index = readIndex().filter((m) => m.planId !== plan.planId);
    index.push(toMeta(plan));
    writeJsonl(indexFile, index);
  }

  function persist(plan, options = {}) {
    // progress 始终由子任务聚合派生，写入前强制重算覆盖（不可手填）。
    const normalized = normalizePlan(plan);
    const next = {
      ...normalized,
      // 默认按叶子事实派生；preserveStatus 用于显式 setPlanStatus（如 stream_error → failed），
      // 避免瞬时失败态在同一次写入中被立刻恢复。后续 recordTaskEvidence 会重新派生。
      status: options.preserveStatus
        ? normalized.status
        : derivePlanStatus(normalized.status, normalized.tasks),
      progress: aggregateProgress(normalized.tasks),
    };
    // 完整写盘优先：清掉 runner-progress 节流状态，避免旧计数回写覆盖。
    clearRunnerProgressState(next.planId);
    writeJsonAtomic(planFile(next.planId), next);
    syncIndex(next);
    notifyChanged('persist', next.planId, {
      conversationId: next.conversationId ?? null,
      changeKind: options.changeKind ?? 'persist',
      ...(options.runner ? { runner: options.runner } : {}),
    });
    return next;
  }

  function activeMeta(meta) {
    return !isInactivePlan(meta);
  }

  function listPlans() {
    return readIndex()
      .map(normalizePlan)
      .filter((m) => m && activeMeta(m))
      .sort((a, b) =>
        String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')),
      );
  }

  function listPlansByConversation(conversationId) {
    const normalizedConversationId = normalizeConversationId(conversationId);
    if (normalizedConversationId === null) return [];
    return listPlans().filter((m) => normalizeConversationId(m.conversationId) === normalizedConversationId);
  }

  /**
   * 侧栏徽标聚合：只扫 index meta，不 hydrate 全量 plan JSON。
   * 返回 { [conversationId]: number }，仅包含 awaiting_approval > 0 的会话。
   */
  function countAwaitingApprovalsByConversation() {
    const counts = Object.create(null);
    for (const meta of readIndex()) {
      const m = normalizePlan(meta);
      if (!m || isInactivePlan(m)) continue;
      if (m.status !== 'awaiting_approval') continue;
      const conversationId = normalizeConversationId(m.conversationId);
      if (!conversationId) continue;
      counts[conversationId] = (counts[conversationId] || 0) + 1;
    }
    return counts;
  }

  function hydratePlanMeta(meta) {
    if (!meta?.planId) return null;
    const plan = getPlan(meta.planId);
    if (!plan || isInactivePlan(plan)) return null;
    if (plan.progress) return plan;
    return { ...plan, progress: aggregateProgress(plan.tasks) };
  }

  function listPlanDetails() {
    return listPlans().map(hydratePlanMeta).filter(Boolean);
  }

  function listPlanDetailsByConversation(conversationId) {
    const normalizedConversationId = normalizeConversationId(conversationId);
    if (normalizedConversationId === null) return [];
    return listPlansByConversation(normalizedConversationId).map(hydratePlanMeta).filter(Boolean);
  }

  function getActivePlanByConversation(conversationId) {
    const normalizedConversationId = normalizeConversationId(conversationId);
    if (normalizedConversationId === null) return null;
    const activePlans = listPlanDetailsByConversation(normalizedConversationId)
      .filter(isActivePlan)
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    return activePlans[0] ?? null;
  }

  function getPlan(planId) {
    const overlay = runnerProgressOverlay.get(planId);
    if (overlay) return normalizePlan(overlay);
    return normalizePlan(readJson(planFile(planId)));
  }

  /**
   * 同会话「单活跃计划」约束：新建计划落库前，把同一会话下其它仍处于活跃态
   * （drafting / awaiting_approval / approved / executing / paused）的旧计划做收尾或作废，
   * 从源头杜绝「僵尸计划」累积——否则用户中途改方案另起新计划时，旧计划永远停在
   * awaiting_approval 或 executing，让浮条长期显示「待批准 / 执行中」、锁定展开且计划数虚高。
   *
   * 收尾策略（按旧计划当前状态分流）：
   * - awaiting_approval：尚未批准的草稿，直接作废为 cancelled（既有行为，保持不变）。
   * - 其它活跃态（drafting / approved / executing / paused）：
   *   · 若旧计划存在叶子且全部叶子均为终态（completed/failed），按 derivePlanStatus
   *     如实收尾为 completed/failed（不谎报、保留真实完成度）；
   *   · 否则仍有未完成叶子，作废为 cancelled，并在审计原因里标注 superseded。
   *
   * 设计约束：
   * - 仅在 conversationId 非空时生效（未关联会话的计划互不影响，绝不按 null===null 误伤）。
   * - exceptPlanId 排除新计划自身。
   * - 走 persist 正规写盘 + onChange 广播（不旁路），并向 revisionHistory 追加一条
   *   supersede 审计，保留可追溯事实。
   * - 只对活跃态计划生效；已是 completed/failed/cancelled 等终态的旧计划不再触碰。
   *
   * @param {string|null|undefined} conversationId
   * @param {string|null|undefined} exceptPlanId
   * @param {string} [reason]
   * @returns {string[]} 被收尾或作废的 planId 列表
   */
  function supersedeAwaitingDrafts(conversationId, exceptPlanId, reason) {
    const normalizedConversationId = normalizeConversationId(conversationId);
    if (normalizedConversationId === null) return [];
    const superseded = [];
    for (const meta of listPlansByConversation(normalizedConversationId)) {
      if (meta.planId === exceptPlanId) continue;
      // 仅处理仍处于活跃态的旧计划；终态计划不再触碰。
      if (!isActivePlan(meta)) continue;
      const plan = getPlan(meta.planId);
      // 二次校验全量计划状态，避免 index 与计划文件偶发不一致时误作废。
      if (!plan || !isActivePlan(plan)) continue;

      let nextStatus;
      let reasonText;
      if (plan.status === 'awaiting_approval') {
        // 未批准草稿：保持既有行为，直接作废。
        nextStatus = 'cancelled';
        reasonText = reason || 'superseded by a newer plan in the same conversation';
      } else {
        // 其它活跃态：能 derive 到终态的如实收尾，否则作废。
        // 以 'executing' 为基准探测叶子终态（derivePlanStatus 仅在 executing 分支做收尾派生）。
        const derived = derivePlanStatus('executing', plan.tasks);
        if (derived === TERMINAL_OK || derived === TERMINAL_FAIL) {
          nextStatus = derived;
          reasonText =
            'auto-finalized on supersede: all subtasks reached terminal state';
        } else {
          nextStatus = 'cancelled';
          reasonText =
            reason || 'superseded by a newer active plan in the same conversation';
        }
      }

      const nextVersion = (plan.version || 1) + 1;
      persist({
        ...plan,
        status: nextStatus,
        version: nextVersion,
        revisionHistory: [
          ...(plan.revisionHistory || []),
          {
            version: nextVersion,
            reason: reasonText,
            changedAt: new Date().toISOString(),
            changedBy: 'system:supersede',
          },
        ],
        updatedAt: new Date().toISOString(),
      });
      superseded.push(meta.planId);
    }
    return superseded;
  }

  /**
   * 创建草稿计划（status='drafting'）。progress 由 tasks 聚合派生。
   *
   * 同会话单活跃计划：落库前先对同会话其它仍处于活跃态（drafting / awaiting_approval /
   * approved / executing / paused）的旧计划做收尾或作废（见 supersedeAwaitingDrafts）——
   * 全叶子终态的如实收尾为 completed/failed，否则作废为 cancelled，杜绝「僵尸 executing 计划」累积。
   */
  function createPlan(draft = {}) {
    const now = new Date().toISOString();
    const tasks = Array.isArray(draft.tasks) ? draft.tasks : [];
    const workflowKind = normalizeWorkflowKind(draft.workflowKind);
    const status = draft.status || (workflowKind === 'goal_self_driven' ? 'accepted' : 'drafting');
    const planId = draft.planId || randomUUID();
    const requestedParentPlanId = typeof draft.parentPlanId === 'string' && draft.parentPlanId.trim()
      ? draft.parentPlanId.trim()
      : undefined;
    const requestedSourceTaskId = typeof draft.sourceTaskId === 'string' && draft.sourceTaskId.trim()
      ? draft.sourceTaskId.trim()
      : undefined;
    const parentPlan = requestedParentPlanId ? getPlan(requestedParentPlanId) : null;
    const sourceTask = parentPlan && requestedSourceTaskId
      ? parentPlan.tasks?.find((task) => task.taskId === requestedSourceTaskId)
      : null;
    if (requestedParentPlanId && !parentPlan) {
      throw new Error(`Parent goal not found: ${requestedParentPlanId}`);
    }
    if (requestedParentPlanId && !requestedSourceTaskId) {
      throw new Error('sourceTaskId is required when parentPlanId is provided');
    }
    if (requestedSourceTaskId && !requestedParentPlanId) {
      throw new Error('parentPlanId is required when sourceTaskId is provided');
    }
    if (requestedSourceTaskId && !sourceTask) {
      throw new Error(`Source task not found in parent goal: ${requestedSourceTaskId}`);
    }
    const plan = {
      planId,
      conversationId: normalizeConversationId(draft.conversationId) ?? undefined,
      threadId: draft.threadId,
      agentId: draft.agentId,
      originWorkspacePath: normalizeWorkspacePath(draft.originWorkspacePath) ?? undefined,
      targetWorkspacePath: normalizeWorkspacePath(draft.targetWorkspacePath) ?? undefined,
      parentPlanId: parentPlan?.planId,
      sourceTaskId: sourceTask?.taskId,
      rootPlanId: parentPlan ? (parentPlan.rootPlanId || parentPlan.planId) : undefined,
      relationType: parentPlan ? 'derived' : undefined,
      depth: parentPlan ? (Number.isInteger(parentPlan.depth) ? parentPlan.depth + 1 : 1) : undefined,
      title: draft.title || '',
      goal: draft.goal || '',
      // 成功标准规范化为结构化 SuccessCriterion[]（字符串向后兼容归一为 manual）。
      successCriteria: normalizeSuccessCriteria(draft.successCriteria),
      // 验证结果：post-act 由 goal_update_task 回写，创建时默认空。
      criterionResults: normalizeCriterionResults(draft.criterionResults),
      // Manual DoD 的治理确认事实。它不是 plan approval，只服务完成前人工验收。
      manualConfirmations: normalizeManualConfirmations(draft.manualConfirmations),
      boundaries: draft.boundaries || { inScope: [], outOfScope: [] },
      exceptionPolicies: draft.exceptionPolicies || [],
      involvedFiles: draft.involvedFiles || [],
      tasks,
      workflowKind,
      activation: normalizeActivation(draft.activation, workflowKind, status),
      executionPolicy: normalizeExecutionPolicy(draft.executionPolicy, workflowKind),
      status,
      approval: draft.approval,
      progress: aggregateProgress(tasks),
      runTrace: draft.runTrace,
      version: 1,
      revisionHistory: [],
      evidenceRefs: draft.evidenceRefs || [],
      promptContextEpochId: draft.promptContextEpochId,
      createdAt: now,
      updatedAt: now,
      createdBy: draft.createdBy,
    };
    const isGoalIntake = workflowKind === 'goal_self_driven' && plan.activation?.kind === 'intake';
    const createEventType = isGoalIntake
      ? 'goal_intake_started'
      : workflowKind === 'goal_self_driven'
        ? 'goal_created'
        : 'plan_created';
    const createEventSummary = isGoalIntake
      ? '开始判断这是不是一个目标'
      : workflowKind === 'goal_self_driven'
        ? '目标已建立'
        : '计划已生成';
    // 单活跃计划：先收尾/作废同会话其它活跃态旧计划（排除自身），再落库新计划。
    supersedeAwaitingDrafts(plan.conversationId, plan.planId);
    const created = persist(withRunTraceEvent(plan, {
      type: createEventType,
      summary: createEventSummary,
      payload: {
        source: 'goal-plan-store:createPlan',
        summaryCode: createEventType,
        workflowKind,
        status,
        activationKind: plan.activation?.kind,
        taskCount: tasks.length,
      },
    }));
    if (parentPlan && sourceTask) {
      const now = new Date().toISOString();
      const linked = updateTaskInTree(parentPlan.tasks, sourceTask.taskId, (task) => ({
        ...task,
        executionMode: 'delegated',
        childPlanIds: [...new Set([...(task.childPlanIds || []), created.planId])],
      }));
      const relationPayload = {
        parentPlanId: parentPlan.planId,
        childPlanId: created.planId,
        sourceTaskId: sourceTask.taskId,
        rootPlanId: created.rootPlanId,
      };
      persist({ ...parentPlan, tasks: linked.tasks, updatedAt: now });
      appendRunEvent(parentPlan.planId, {
        type: 'child_goal_created',
        taskId: sourceTask.taskId,
        payload: relationPayload,
      });
      appendRunEvent(created.planId, {
        type: 'child_goal_created',
        taskId: sourceTask.taskId,
        payload: relationPayload,
      });
    }
    return created;
  }

  function createGoalContract(draft = {}) {
    const goal = typeof draft.goal === 'string' ? draft.goal : '';
    const tasks = Array.isArray(draft.tasks) && draft.tasks.length > 0
      ? draft.tasks
      : [makeDefaultGoalTask(goal)];
    const acceptedAt = typeof draft.activation?.acceptedAt === 'string' && draft.activation.acceptedAt.trim()
      ? draft.activation.acceptedAt.trim()
      : new Date().toISOString();
    return createPlan({
      ...draft,
      tasks,
      status: draft.status || 'accepted',
      workflowKind: 'goal_self_driven',
      activation: {
        kind: 'accepted_goal',
        sourceMessageId: draft.activation?.sourceMessageId,
        acceptedAt,
        acceptedBy: draft.activation?.acceptedBy || draft.createdBy || 'user',
      },
      executionPolicy: {
        ...DEFAULT_SELF_DRIVEN_POLICY,
        ...(draft.executionPolicy && typeof draft.executionPolicy === 'object'
          ? draft.executionPolicy
          : {}),
        autonomy: 'self_driven',
      },
      createdBy: draft.createdBy || 'user',
    });
  }

  /**
   * 创建 intake 判别契约：工作流仍是自驱 goal（Runner 会驱动），但 activation.kind='intake'，
   * 表示尚未确认是否为一个真实目标。Runner 在 intake 阶段只做只读/问答/澄清，禁副作用。
   * 判定为纯问答由上层 deletePlan 静默移除；判定为明确目标则 promoteIntakeToGoal 升级。
   */
  function createIntakeContract(draft = {}) {
    const goal = typeof draft.goal === 'string' ? draft.goal : '';
    const tasks = Array.isArray(draft.tasks) && draft.tasks.length > 0
      ? draft.tasks
      : [makeDefaultGoalTask(goal)];
    return createPlan({
      ...draft,
      tasks,
      status: draft.status || 'executing',
      workflowKind: 'goal_self_driven',
      activation: {
        kind: 'intake',
        sourceMessageId: draft.activation?.sourceMessageId,
      },
      executionPolicy: {
        ...DEFAULT_SELF_DRIVEN_POLICY,
        ...(draft.executionPolicy && typeof draft.executionPolicy === 'object'
          ? draft.executionPolicy
          : {}),
        autonomy: 'self_driven',
      },
      createdBy: draft.createdBy || 'user',
    });
  }

  /**
   * 把一条 intake 契约升级为正式的 accepted_goal（判定为明确目标时调用）。
   * 允许传入判别后梳理出的结构化 goal/title/successCriteria/tasks/boundaries 覆盖原草稿。
   */
  function promoteIntakeToGoal(planId, patch = {}) {
    const plan = getPlan(planId);
    if (!plan) return null;
    const acceptedAt = new Date().toISOString();
    return revisePlan(planId, {
      ...patch,
      status: 'executing',
      workflowKind: 'goal_self_driven',
      activation: {
        kind: 'accepted_goal',
        sourceMessageId: plan.activation?.sourceMessageId,
        acceptedAt,
        acceptedBy: 'user',
        intakeResolution: 'goal_confirmed',
      },
      revisionReason: patch.revisionReason || 'intake:goal_confirmed',
      changedBy: patch.changedBy || 'goal-runner:intake',
    });
  }

  function upsertGoalContract(conversationId, draft = {}) {
    const normalizedConversationId = normalizeConversationId(conversationId);
    const {
      revisionReason,
      changedBy,
      createdBy,
      ...planPatch
    } = draft;
    const activeGoal = normalizedConversationId
      ? listPlanDetailsByConversation(normalizedConversationId)
        .filter((plan) => isActivePlan(plan) && isSelfDrivenGoal(plan))
        .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0]
      : null;
    if (!activeGoal) {
      return createGoalContract({ ...draft, conversationId: normalizedConversationId ?? draft.conversationId });
    }

    const safeStatus = activeGoal.status === 'accepted' || activeGoal.status === 'executing' || activeGoal.status === 'paused'
      ? activeGoal.status
      : 'accepted';
    const tasks = Array.isArray(planPatch.tasks) && planPatch.tasks.length > 0 ? planPatch.tasks : activeGoal.tasks;
    return revisePlan(activeGoal.planId, {
      ...planPatch,
      conversationId: normalizedConversationId ?? activeGoal.conversationId,
      tasks,
      status: planPatch.status || safeStatus,
      workflowKind: 'goal_self_driven',
      activation: {
        ...(activeGoal.activation || {}),
        ...(planPatch.activation || {}),
        kind: 'accepted_goal',
        acceptedAt: activeGoal.activation?.acceptedAt || planPatch.activation?.acceptedAt || new Date().toISOString(),
      },
      executionPolicy: {
        ...(activeGoal.executionPolicy || DEFAULT_SELF_DRIVEN_POLICY),
        ...(planPatch.executionPolicy || {}),
        autonomy: 'self_driven',
      },
    }, {
      reason: revisionReason || '更新了目标内容',
      changedBy: changedBy || createdBy || 'agent',
    });
  }

  /**
   * 修订计划内容（先规划阶段的反复修改 / revise）。
   * 递增 version，并向 revisionHistory 追加一条。progress 自动重算。
   * 不允许通过本方法直接改 progress（会被忽略并重算）。
   */
  function revisePlan(planId, patch = {}, { reason, changedBy } = {}) {
    const plan = getPlan(planId);
    if (!plan) return null;
    const { progress: _ignore, version: _v, revisionHistory: _rh, ...safePatch } = patch;
    // 修订若携带成功标准/验证结果，同样走结构化规范化（与 createPlan 一致，
    // 避免修订路径把结构化 DoD 退化成未校验的裸对象）。
    if ('successCriteria' in safePatch) {
      safePatch.successCriteria = normalizeSuccessCriteria(safePatch.successCriteria);
    }
    if ('criterionResults' in safePatch) {
      safePatch.criterionResults = normalizeCriterionResults(safePatch.criterionResults);
    }
    if ('manualConfirmations' in safePatch) {
      safePatch.manualConfirmations = normalizeManualConfirmations(safePatch.manualConfirmations);
    }
    const nextVersion = (plan.version || 1) + 1;
    const next = {
      ...plan,
      ...safePatch,
      version: nextVersion,
      revisionHistory: [
        ...(plan.revisionHistory || []),
        {
          version: nextVersion,
          reason: reason || '',
          changedAt: new Date().toISOString(),
          changedBy,
        },
      ],
      updatedAt: new Date().toISOString(),
    };
    return persist(withRunTraceEvent(next, {
      type: 'plan_revised',
      summary: reason ? `计划有调整：${reason}` : '计划有调整',
      payload: {
        summaryCode: 'plan_revised',
        reason: reason || null,
        changedBy: changedBy || null,
        version: nextVersion,
      },
    }));
  }

  /**
   * 记录批准事实（Evidence），并按决策推进计划状态机：
   * - approve → 'approved'
   * - reject  → 回到 'drafting'
   * - revise  → 'drafting'（等待修订）
   */
  function recordApproval(planId, approval = {}) {
    const plan = getPlan(planId);
    if (!plan) return null;
    const decision = approval.decision;
    let status = plan.status;
    if (decision === 'approve') status = 'approved';
    else if (decision === 'reject') status = 'cancelled';
    else if (decision === 'revise') status = 'drafting';
    const workflowKind = plan.workflowKind || 'plan_approval';
    const next = {
      ...plan,
      approval: {
        decision,
        confirmationId: approval.confirmationId || randomUUID(),
        decidedBy: approval.decidedBy,
        decidedAt: approval.decidedAt || new Date().toISOString(),
        feedback: approval.feedback,
      },
      activation: decision === 'approve'
        ? { kind: 'approved_plan' }
        : normalizeActivation(plan.activation, workflowKind, status),
      executionPolicy: normalizeExecutionPolicy(plan.executionPolicy, workflowKind),
      status,
      updatedAt: new Date().toISOString(),
    };
    return persist(next);
  }

  /** 推进计划整体状态（executing / paused / completed / cancelled / failed）。 */
  function setPlanStatus(planId, status) {
    const plan = getPlan(planId);
    if (!plan) return null;
    // 显式状态写入保留调用方给定值（例如 stream_error → failed），
    // 不在此处被 derivePlanStatus 立即改写；后续 recordTaskEvidence 等
    // 叶子事实更新会重新派生，从而在任务全部成功时恢复 completed/executing。
    return persist(
      { ...plan, status, updatedAt: new Date().toISOString() },
      { preserveStatus: true },
    );
  }

  /**
   * 恢复 Goal Runner 执行：一次持久化同时恢复计划与 Runner，避免界面观察到中间态。
   * 历史 runTrace / problems 保持不变；仅清理当前失败字段。
   */
  function resumeRunner(planId, patch = {}) {
    const plan = getPlan(planId);
    if (!plan) return null;
    const now = new Date().toISOString();
    const current = normalizeRunnerState(plan.runner, planId) || {
      enabled: false,
      status: 'idle',
      turnCount: 0,
      roundCount: 0,
      toolCallCount: 0,
      explorerCount: 0,
      maxTurns: 8,
      maxToolCalls: 40,
      maxExplorers: 3,
      explorerConcurrency: DEFAULT_EXPLORER_CONCURRENCY,
      updatedAt: now,
    };
    const nextRunner = normalizeRunnerState({
      ...current,
      ...patch,
      enabled: true,
      status: 'running',
      blockerAudit: null,
      blockedReason: undefined,
      lastError: undefined,
      updatedAt: patch.updatedAt || now,
    }, planId);
    return persist({ ...plan, status: 'executing', runner: nextRunner, updatedAt: now });
  }

  /** 更新 Goal Runner 托管推进状态；不允许借此改写任务状态或 evidence。 */
  function setRunnerState(planId, patch = {}) {
    const plan = getPlan(planId);
    if (!plan) return null;
    const now = new Date().toISOString();
    const current = normalizeRunnerState(plan.runner, planId) || {
      enabled: false,
      status: 'idle',
      turnCount: 0,
      roundCount: 0,
      toolCallCount: 0,
      explorerCount: 0,
      maxTurns: 8,
      maxToolCalls: 40,
      maxExplorers: 3,
      explorerConcurrency: DEFAULT_EXPLORER_CONCURRENCY,
      updatedAt: now,
    };
    const nextRunner = normalizeRunnerState({ ...current, ...patch, updatedAt: patch.updatedAt || now }, planId);
    const changeKind = classifyRunnerChangeKind(patch);
    const nextPlan = { ...plan, runner: nextRunner, updatedAt: now };

    // 高频 runner 进度：内存即时可见 + 广播 runner-progress（带 runner 本地 patch），
    // 写盘节流到 300ms，避免每个 tick 全量 list 与磁盘抖动。
    if (changeKind === 'runner-progress') {
      const normalized = normalizePlan(nextPlan);
      const next = {
        ...normalized,
        status: derivePlanStatus(normalized.status, normalized.tasks),
        progress: aggregateProgress(normalized.tasks),
      };
      runnerProgressOverlay.set(planId, next);
      scheduleRunnerProgressPersist(planId);
      notifyChanged('persist', next.planId, {
        conversationId: next.conversationId ?? null,
        changeKind: 'runner-progress',
        runner: next.runner ?? null,
      });
      return next;
    }

    // 状态跃迁/终态等：立即 flush + 完整 persist（会清 overlay）。
    return persist(nextPlan, {
      changeKind: 'runner-state',
      runner: nextRunner,
    });
  }

  /** Append a structured Goal / Plan / Run execution event without changing task Evidence. */
  function appendRunEvent(planId, event = {}) {
    const plan = getPlan(planId);
    if (!plan) return null;
    const now = new Date().toISOString();
    const current = normalizeRunTrace(plan.runTrace, { goalPlanId: planId });
    const normalizedEvent = normalizeRunEvent({
      ...event,
      goalPlanId: planId,
      createdAt: event.createdAt || now,
    }, { goalPlanId: planId });
    if (!normalizedEvent) {
      throw new Error(`[goal-plan-store] invalid run event for plan ${planId}`);
    }
    const nextTrace = {
      ...current,
      events: [...current.events, normalizedEvent],
    };
    const activeNodeId = normalizeOptionalString(event.activeNodeId) || normalizedEvent.nodeId;
    if (activeNodeId) nextTrace.activeNodeId = activeNodeId;
    if (normalizedEvent.type === 'checkpoint_created' && activeNodeId) {
      nextTrace.lastCheckpointNodeId = activeNodeId;
    }
    return persist({ ...plan, runTrace: nextTrace, updatedAt: now });
  }

  /** 动态派发只读 Explorer 子 Agent 实例；只记录运行契约，不改写任务状态或 Evidence。 */
  function dispatchExplorer(planId, request = {}) {
    const plan = getPlan(planId);
    if (!plan) return null;
    const now = new Date().toISOString();
    const current = normalizeRunnerState(plan.runner, planId) || {
      enabled: true,
      status: 'idle',
      turnCount: 0,
      toolCallCount: 0,
      explorerCount: 0,
      maxTurns: 8,
      maxToolCalls: 40,
      maxExplorers: 3,
      explorerConcurrency: DEFAULT_EXPLORER_CONCURRENCY,
      updatedAt: now,
    };
    // 并发模型：不再对「每计划累计 Explorer 总数」设闸（该累计上限语义已弃用），
    // 计划总数由 runner 的 maxTurns 天然兜底；每 turn 的并发上限由 goal-runner 侧的
    // explorerConcurrency 并发池控制。此处只负责登记本次派发。
    const explorers = Array.isArray(current.explorers) ? current.explorers : [];
    const batchId = typeof request.batchId === 'string' && request.batchId.trim()
      ? request.batchId.trim()
      : undefined;
    const explorerId = typeof request.explorerId === 'string' && request.explorerId.trim()
      ? request.explorerId.trim()
      : randomUUID();
    const explorerRun = normalizeExplorerRun({
      explorerId,
      status: request.status || 'queued',
      request: { ...request, explorerId, planId },
      batchId,
      createdAt: request.createdAt || now,
      updatedAt: request.updatedAt || now,
    }, { explorerId, planId, batchId });
    if (!explorerRun) {
      throw new Error(`[goal-plan-store] invalid explorer request for plan ${planId}`);
    }
    const nextExplorers = [...explorers, explorerRun];
    const nextRunner = normalizeRunnerState({
      ...current,
      enabled: true,
      status: 'exploring',
      intent: 'explore',
      explorerCount: countExplorerRuns(nextExplorers),
      explorers: nextExplorers,
      // 本轮进度：属于同一 batchId 的 Explorer 归集为一批（total 递增、done 从 0 起）。
      // 无 batchId（旧单发路径）时保持既有 batch 不变。
      explorerBatch: batchId ? computeExplorerBatch(nextExplorers, batchId) : current.explorerBatch,
      updatedAt: now,
    }, planId);
    return persist({ ...plan, runner: nextRunner, updatedAt: now });
  }

  /** 回填 Explorer 报告；完成态必须引用本次 Explorer 工具执行产生的 evidenceRefs。 */
  function reportExplorer(planId, explorerId, report = {}) {
    const plan = getPlan(planId);
    if (!plan) return null;
    const now = new Date().toISOString();
    const current = normalizeRunnerState(plan.runner, planId);
    if (!current) return null;
    const explorers = Array.isArray(current.explorers) ? current.explorers : [];
    const index = explorers.findIndex((run) => run.explorerId === explorerId);
    if (index < 0) return null;
    const status = EXPLORER_STATUSES.has(report.status) ? report.status : 'completed';
    const normalizedReport = normalizeExplorerReport({
      ...report,
      explorerId,
      planId,
      question: report.question || explorers[index].request?.question,
      createdAt: report.createdAt || now,
    });
    const registeredEvidenceRefs = normalizeExplorerRegistryRefs(report, explorers[index]);
    if (status === 'completed') {
      assertExplorerReportEvidenceRegistered({
        explorerId,
        report: normalizedReport,
        registeredRefs: registeredEvidenceRefs,
      });
    }
    const nextRun = normalizeExplorerRun({
      ...explorers[index],
      status,
      report: normalizedReport,
      evidenceRefs: registeredEvidenceRefs,
      failureReason: report.failureReason,
      updatedAt: report.updatedAt || now,
    }, { explorerId, planId });
    const nextExplorers = explorers.map((run, idx) => (idx === index ? nextRun : run));
    const stillRunning = nextExplorers.some((run) => run.status === 'queued' || run.status === 'running');
    // 本轮进度：以被回填 Explorer 所属 batch 重算 done/total；该 explorer 不属于任何
    // batch（旧单发路径）时保持既有 batch 不变。
    const reportedBatchId = nextRun.batchId;
    const nextRunner = normalizeRunnerState({
      ...current,
      status: stillRunning ? 'exploring' : 'idle',
      intent: stillRunning ? 'explore' : 'verify',
      explorerCount: countExplorerRuns(nextExplorers),
      explorers: nextExplorers,
      explorerBatch: reportedBatchId
        ? computeExplorerBatch(nextExplorers, reportedBatchId)
        : current.explorerBatch,
      updatedAt: now,
    }, planId);
    return persist({ ...plan, runner: nextRunner, updatedAt: now });
  }

  /**
   * 记录 Verifier 运行事实。VerifierRun 是验证动作的审计轨迹，不替代任务 Evidence
   * 或 CriterionResult；实际完成/通过仍分别由 recordTaskEvidence / recordCriterionResults
   * 明确回写。
   */
  function recordVerifierRun(planId, run = {}) {
    const plan = getPlan(planId);
    if (!plan) return null;
    const now = new Date().toISOString();
    const verifierRunId = typeof run.verifierRunId === 'string' && run.verifierRunId.trim()
      ? run.verifierRunId.trim()
      : randomUUID();
    const nextRun = normalizeVerifierRun({
      ...run,
      verifierRunId,
      planId,
      updatedAt: run.updatedAt || now,
    }, { verifierRunId, planId });
    if (!nextRun) {
      throw new Error(`[goal-plan-store] invalid verifier run for plan ${planId}`);
    }
    if (nextRun.target.kind === 'task' && !taskExistsInTree(plan.tasks, nextRun.target.taskId)) {
      throw new Error(
        `[goal-plan-store] verifier target task ${nextRun.target.taskId} not found in plan ${planId}`,
      );
    }
    if (nextRun.target.kind === 'success_criterion') {
      const knownIds = new Set(
        (Array.isArray(plan.successCriteria) ? plan.successCriteria : [])
          .map((c) => (c && typeof c.id === 'string' ? c.id : null))
          .filter(Boolean),
      );
      if (!knownIds.has(nextRun.target.criterionId)) {
        throw new Error(
          `[goal-plan-store] verifier target criterion ${nextRun.target.criterionId} not found in plan ${planId}`,
        );
      }
    }
    if (nextRun.status === 'passed' && nextRun.evidenceRefs.length === 0) {
      throw new Error(
        `[goal-plan-store] verifier run ${verifierRunId} cannot be 'passed' without evidenceRefs`,
      );
    }
    const current = normalizeRunnerState(plan.runner, planId) || {
      enabled: false,
      status: 'idle',
      turnCount: 0,
      roundCount: 0,
      toolCallCount: 0,
      explorerCount: 0,
      maxTurns: 8,
      maxToolCalls: 40,
      maxExplorers: 3,
      explorerConcurrency: DEFAULT_EXPLORER_CONCURRENCY,
      updatedAt: now,
    };
    const verifierRuns = Array.isArray(current.verifierRuns) ? current.verifierRuns : [];
    const index = verifierRuns.findIndex((item) => item.verifierRunId === verifierRunId);
    const nextVerifierRuns = index >= 0
      ? verifierRuns.map((item, idx) => (idx === index ? nextRun : item))
      : [...verifierRuns, nextRun];
    const nextRunner = normalizeRunnerState({
      ...current,
      verifierRuns: nextVerifierRuns,
      updatedAt: now,
    }, planId);
    return persist({ ...plan, runner: nextRunner, updatedAt: now });
  }

  /**
   * 由 Evidence 回写子任务状态。约束（提案 §6）：
   * - 置为 'completed' 必须提供非空 evidenceRefs，否则抛错。
   * - progress 在 persist 时自动重算。
   *
   * @param {string} planId
   * @param {string} taskId
   * @param {{status:string, evidenceRefs?:string[], result?:string,
   *          failureReason?:string, blockedReason?:string}} change
   */
  function recordTaskEvidence(planId, taskId, change = {}) {
    const plan = getPlan(planId);
    if (!plan) return null;
    const { status } = change;
    // Layer B 护栏：批准闸门守在源头。
    // 计划在批准前（drafting / awaiting_approval）不允许把任何子任务标成
    // 「开工/终结」态（running / completed / failed / waiting_user）——否则会绕过
    // 面板审批直接触发执行语义，并与 derivePlanStatus 规则 1 一起制造僵死态。
    // 只有 recordApproval 把计划推进到 approved 之后，任务才能进入这些状态。
    const PRE_APPROVAL_PLAN = new Set(['drafting', 'awaiting_approval']);
    const EXECUTION_TASK_STATUS = new Set([
      'running',
      TERMINAL_OK,
      TERMINAL_FAIL,
      'waiting_user',
    ]);
    if (
      status !== undefined &&
      EXECUTION_TASK_STATUS.has(status) &&
      goalPlanRequiresApproval(plan) &&
      PRE_APPROVAL_PLAN.has(plan.status)
    ) {
      throw new Error(
        `[goal-plan-store] task ${taskId} cannot enter '${status}' before plan ${planId} is approved (plan status: '${plan.status}')`,
      );
    }
    const mergedRefs = (refs, add) => {
      const set = new Set([
        ...normalizeEvidenceRefList(refs),
        ...normalizeEvidenceRefList(add),
      ]);
      return [...set];
    };
    const existingTask = findTaskInTree(plan.tasks, taskId);
    if (!existingTask) {
      throw new Error(`[goal-plan-store] task ${taskId} not found in plan ${planId}`);
    }
    if (status === TERMINAL_OK) {
      const incoming = normalizeEvidenceRefList(change.evidenceRefs);
      const evidenceRefs = mergedRefs(existingTask.evidenceRefs, incoming);
      if (evidenceRefs.length === 0) {
        throw new Error(
          `[goal-plan-store] task ${taskId} cannot be 'completed' without evidenceRefs`,
        );
      }
      assertAnyEvidenceRefIndexed(plan, evidenceRefs, `task ${taskId}`);
    }
    const now = new Date().toISOString();
    const { tasks, found } = updateTaskInTree(plan.tasks, taskId, (t) => {
      const nextRefs = mergedRefs(t.evidenceRefs, change.evidenceRefs);
      const updated = {
        ...t,
        status: status ?? t.status,
        evidenceRefs: nextRefs,
      };
      if (change.result !== undefined) updated.result = change.result;
      if (change.failureReason !== undefined) updated.failureReason = change.failureReason;
      if (change.blockedReason !== undefined) updated.blockedReason = change.blockedReason;
      if (status === 'running' && !t.startedAt) updated.startedAt = now;
      if (status === TERMINAL_OK || status === TERMINAL_FAIL) updated.completedAt = now;
      return updated;
    });
    if (!found) throw new Error(`[goal-plan-store] task ${taskId} not found in plan ${planId}`);
    const updatedPlan = persist({ ...plan, tasks, updatedAt: now });
    if (updatedPlan.parentPlanId && updatedPlan.sourceTaskId) {
      const childTasks = [];
      const collectChildLeaves = (tasks) => {
        for (const task of tasks || []) {
          if (Array.isArray(task.subtasks) && task.subtasks.length > 0) collectChildLeaves(task.subtasks);
          else childTasks.push(task);
        }
      };
      collectChildLeaves(updatedPlan.tasks);
      const childFailed = childTasks.some((task) => task.status === TERMINAL_FAIL || task.status === BLOCKED);
      const childComplete = childTasks.length > 0 && childTasks.every((task) => task.status === TERMINAL_OK);
      const childStarted = childTasks.some((task) => task.status !== 'pending');
      const delegatedStatus = childFailed
        ? BLOCKED
        : childComplete
          ? 'waiting_user'
          : childStarted
            ? 'running'
            : 'pending';
      const parent = getPlan(updatedPlan.parentPlanId);
      if (parent) {
        const linked = updateTaskInTree(parent.tasks, updatedPlan.sourceTaskId, (task) => ({
          ...task,
          status: delegatedStatus,
          executionMode: 'delegated',
          childPlanIds: [...new Set([...(task.childPlanIds || []), updatedPlan.planId])],
          ...(childFailed ? { blockedReason: `派生子目标 ${updatedPlan.title} 未成功完成` } : {}),
        }));
        if (linked.found) {
          persist({ ...parent, tasks: linked.tasks, updatedAt: now });
          const relationEventType = childFailed
            ? 'child_goal_failed'
            : childComplete
              ? 'child_goal_completed'
              : childStarted
                ? 'child_goal_started'
                : null;
          if (relationEventType) {
            const payload = {
              parentPlanId: parent.planId,
              childPlanId: updatedPlan.planId,
              sourceTaskId: updatedPlan.sourceTaskId,
              rootPlanId: updatedPlan.rootPlanId,
            };
            const previous = [...(updatedPlan.runTrace?.events || [])].reverse().find((event) =>
              event.type === relationEventType && event.payload?.parentPlanId === parent.planId,
            );
            if (!previous) {
              appendRunEvent(parent.planId, {
                type: relationEventType,
                taskId: updatedPlan.sourceTaskId,
                payload,
              });
              appendRunEvent(updatedPlan.planId, {
                type: relationEventType,
                taskId,
                payload,
              });
            }
          }
        }
      }
    }
    return getPlan(updatedPlan.planId);
  }

  /**
   * 回写成功标准（DoD）的验证结果 —— DoD-as-Code 的落盘入口。
   *
   * post-act 阶段，Runner 对可自动验证的 successCriterion 跑验证（命令/测试/文件检查），
   * 把 Tool Result 作为 evidenceRef 连同 passed 一并回写。按 criterionId 合并：同一
   * criterionId 的新结果覆盖旧结果，其余保留。仅接受计划已声明的 criterionId，避免
   * 凭空造标准绕过完成门。
   *
   * @param {string} planId
   * @param {Array} results CriterionResult[]（criterionId/passed/evidenceRef/detail）
   */
  function recordCriterionResults(planId, results = []) {
    const plan = getPlan(planId);
    if (!plan) return null;
    const incoming = normalizeCriterionResults(results);
    if (incoming.length === 0) return plan;
    const now = new Date().toISOString();
    // 只接受计划已声明的 criterionId，防止捏造标准。
    const knownCriteria = new Map(
      (Array.isArray(plan.successCriteria) ? plan.successCriteria : [])
        .map((c) => (c && typeof c.id === 'string' ? [c.id, c] : null))
        .filter(Boolean),
    );
    const byId = new Map(
      (Array.isArray(plan.criterionResults) ? plan.criterionResults : []).map((r) => [
        r.criterionId,
        r,
      ]),
    );
    for (const r of incoming) {
      const criterion = knownCriteria.get(r.criterionId);
      if (!criterion) continue;
      if (r.passed && AUTO_CRITERION_KINDS.has(criterion.kind) && !r.evidenceRef) {
        throw new Error(
          `[goal-plan-store] criterion ${r.criterionId} cannot be passed without evidenceRef`,
        );
      }
      if (r.evidenceRef) {
        assertEvidenceRefIndexed(plan, r.evidenceRef, `criterion ${r.criterionId}`);
      }
      byId.set(r.criterionId, { ...r, checkedAt: r.checkedAt || now });
    }
    return persist({ ...plan, criterionResults: [...byId.values()], updatedAt: now });
  }

  /**
   * 记录 Manual DoD 的人工确认事实。
   *
   * 这条链路不同于 plan approval：它只在完成门前确认无法自动验证的成功标准，
   * 不授予执行权限，也不替代任务 Evidence / 自动 CriterionResult。
   */
  function recordManualConfirmation(planId, confirmation = {}) {
    const plan = getPlan(planId);
    if (!plan) return null;
    const decision = CONFIRMATION_DECISIONS.has(confirmation.decision)
      ? confirmation.decision
      : null;
    if (!decision) {
      throw new Error(`[goal-plan-store] manual confirmation for plan ${planId} requires a valid decision`);
    }
    const manualCriterionIds = collectManualCriterionIds(plan);
    if (manualCriterionIds.length === 0) {
      throw new Error(`[goal-plan-store] plan ${planId} has no manual success criteria to confirm`);
    }
    const manualSet = new Set(manualCriterionIds);
    const requestedIds = normalizeStringArray(confirmation.criterionIds);
    const criterionIds = requestedIds.length > 0 ? requestedIds : manualCriterionIds;
    const unknownIds = criterionIds.filter((id) => !manualSet.has(id));
    if (unknownIds.length > 0) {
      throw new Error(
        `[goal-plan-store] manual confirmation references unknown manual criteria: ${unknownIds.join(', ')}`,
      );
    }
    const record = normalizeManualConfirmation({
      ...confirmation,
      kind: 'manual_dod',
      decision,
      criterionIds,
      decidedAt: confirmation.decidedAt || new Date().toISOString(),
    });
    if (!record) {
      throw new Error(`[goal-plan-store] invalid manual confirmation for plan ${planId}`);
    }
    return persist({
      ...plan,
      manualConfirmations: [
        ...(Array.isArray(plan.manualConfirmations) ? plan.manualConfirmations : []),
        record,
      ],
      updatedAt: new Date().toISOString(),
    });
  }

  function deletePlan(planId) {
    // 删除前尽量取出 conversationId，便于 renderer 会话过滤。
    const existing = getPlan(planId);
    const conversationId = existing?.conversationId ?? null;
    clearRunnerProgressState(planId);
    const index = readIndex().filter((m) => m.planId !== planId);
    writeJsonl(indexFile, index);
    try {
      if (existsSync(planFile(planId))) unlinkSync(planFile(planId));
    } catch {}
    notifyChanged('delete', planId, {
      conversationId,
      changeKind: 'delete',
    });
    return listPlans();
  }

  /**
   * 级联删除：硬删除某个会话名下的全部计划（见 ADR 34）。
   *
   * 用于「删除会话」时联动清理其计划，避免孤儿计划文件/索引行。
   * 设计约束：
   * - conversationId 归一化为 null（空/未传）时直接 no-op，绝不按 `null === null`
   *   去匹配——否则会误删那些「未关联任何会话」的计划。
   * - 基于 index 行的 conversationId 即可筛选，无需逐个读 plan 文件。
   * - 原子重写 index（一次写盘），再逐个 unlink 计划文件；删除若干计划只广播一次
   *   onChange，复用既有 Seam（renderer 仍走 goalPlans:changed 刷新）。
   *
   * @param {string|null|undefined} conversationId 目标会话 id
   * @returns {Array} 删除后剩余的计划元信息列表（listPlans 形态）
   */
  function deletePlanByConversation(conversationId) {
    const normalizedConversationId = normalizeConversationId(conversationId);
    // 空会话 id 是 no-op：不删除任何计划（尤其不能误删未关联会话的计划）。
    if (normalizedConversationId === null) return listPlans();

    const index = readIndex();
    const removed = index.filter(
      (m) => normalizeConversationId(m.conversationId) === normalizedConversationId,
    );
    if (removed.length === 0) return listPlans();

    const remaining = index.filter(
      (m) => normalizeConversationId(m.conversationId) !== normalizedConversationId,
    );
    // 先原子重写 index（一次写盘），再删除各计划文件。
    writeJsonl(indexFile, remaining);
    for (const meta of removed) {
      try {
        if (existsSync(planFile(meta.planId))) unlinkSync(planFile(meta.planId));
      } catch {}
    }
    // 批量删除只广播一次，避免抖动；planId 传 null 表示非单一计划变更。
    for (const meta of removed) clearRunnerProgressState(meta.planId);
    notifyChanged('delete', null, {
      conversationId: normalizedConversationId,
      changeKind: 'delete',
    });
    return listPlans();
  }

  return {
    listPlans,
    listPlansByConversation,
    countAwaitingApprovalsByConversation,
    listPlanDetails,
    listPlanDetailsByConversation,
    getActivePlanByConversation,
    getPlan,
    createPlan,
    createGoalContract,
    createIntakeContract,
    promoteIntakeToGoal,
    upsertGoalContract,
    revisePlan,
    recordApproval,
    setPlanStatus,
    resumeRunner,
    setRunnerState,
    appendRunEvent,
    dispatchExplorer,
    reportExplorer,
    recordVerifierRun,
    recordEvidenceRefs,
    listEvidenceIndex: readEvidenceIndex,
    recordTaskEvidence,
    recordCriterionResults,
    recordManualConfirmation,
    deletePlan,
    deletePlanByConversation,
  };
}

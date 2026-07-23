/**
 * Goal Runner skeleton —— 主进程托管编排器。
 *
 * 边界：
 * - Runner 只编排 GoalPlan 生命周期与 chat runtime continuation。
 * - Runner 不直接调用 bash/file/MCP/Plugin 等本地能力。
 * - 工具执行、权限、Evidence 仍由注入的 chatRuntime 及既有能力链路负责。
 */

import { derivePlanStatus, goalPlanIsSelfDriven } from './goal-plan-store.mjs';

const DEFAULT_MAX_TURNS = 8;
const DEFAULT_MAX_TOOL_CALLS = 40;
/** @deprecated 语义已弃用（不再作为每计划累计 Explorer 总数上限）；保留仅为兼容旧状态。 */
const DEFAULT_MAX_EXPLORERS = 3;
/** 每个 turn 内 Explorer 的并发上限（并发池大小）。 */
const DEFAULT_EXPLORER_CONCURRENCY = 5;
/** explorerConcurrency 的硬上限，防止某轮请求过多把上游限流打爆。 */
const EXPLORER_CONCURRENCY_HARD_CAP = 8;
/** 连续多少轮双信号（已完成数 + 叶子 Evidence 数）都不增长即判定 no-progress 阻塞。 */
const DEFAULT_NO_PROGRESS_LIMIT = 3;
/** 同一可恢复 blocker 连续出现多少次才真正交还用户。 */
const DEFAULT_BLOCKER_AUDIT_LIMIT = 3;
const INSPECT_EXPLORER_MAX_TOOL_CALLS = 4;
const INSPECT_EXPLORER_MAX_DURATION_MS = 120000;

const TERMINAL_PLAN_STATUSES = new Set(['completed', 'cancelled', 'failed']);
const STOPPED_RUNNER_STATUSES = new Set(['paused', 'blocked', 'budget_exhausted', 'completed', 'failed']);

function toPositiveInteger(value, fallback, { allowZero = false } = {}) {
  if (!Number.isFinite(value)) return fallback;
  const next = Math.trunc(value);
  if (allowZero) return Math.max(0, next);
  return Math.max(1, next);
}

function errorMessage(error) {
  if (!error) return 'Unknown error';
  if (typeof error === 'string') return error;
  if (typeof error.message === 'string' && error.message.trim()) return error.message;
  return String(error);
}

function countToolCalls(result) {
  if (!result || typeof result !== 'object') return 0;
  if (Number.isFinite(result.toolCallCount)) return Math.max(0, Math.trunc(result.toolCallCount));
  if (Array.isArray(result.toolCalls)) return result.toolCalls.length;
  return 0;
}

function normalizeExploreRequests(result) {
  if (!result || typeof result !== 'object') return [];
  const raw = Array.isArray(result.explorers)
    ? result.explorers
    : result.explore
      ? [result.explore]
      : [];
  return raw.filter((request) => request && typeof request === 'object');
}

function collectLeafTasks(plan) {
  const out = [];
  const stack = Array.isArray(plan?.tasks) ? [...plan.tasks] : [];
  while (stack.length > 0) {
    const task = stack.shift();
    if (!task || typeof task !== 'object') continue;
    const subtasks = Array.isArray(task.subtasks) ? task.subtasks : [];
    if (subtasks.length > 0) {
      for (const child of subtasks) stack.push(child);
      continue;
    }
    out.push(task);
  }
  return out;
}


function markActiveLeafTasksFailed(goalPlanStore, planId, message) {
  const plan = typeof goalPlanStore?.getPlan === 'function' ? goalPlanStore.getPlan(planId) : null;
  if (!plan || typeof goalPlanStore?.recordTaskEvidence !== 'function') return [];
  const reason = typeof message === 'string' && message.trim()
    ? message.trim()
    : 'Goal Runner failed';
  const updated = [];
  for (const task of collectLeafTasks(plan)) {
    const status = String(task?.status ?? 'pending');
    if (status !== 'running' && status !== 'waiting_user' && status !== 'blocked') continue;
    const taskId = typeof task?.taskId === 'string' ? task.taskId : null;
    if (!taskId) continue;
    try {
      goalPlanStore.recordTaskEvidence(planId, taskId, {
        status: 'failed',
        failureReason: reason,
        result: reason,
      });
      updated.push(taskId);
    } catch (error) {
      // Keep plan-level failure even if a single task write fails.
    }
  }
  // If no leaf was in an active status, mark the first non-terminal pending leaf so
  // the panel reflects that work stopped mid-flight rather than looking "still pending".
  if (updated.length === 0) {
    const pending = collectLeafTasks(goalPlanStore.getPlan(planId) || plan)
      .find((task) => String(task?.status ?? 'pending') === 'pending' && typeof task?.taskId === 'string');
    if (pending) {
      try {
        goalPlanStore.recordTaskEvidence(planId, pending.taskId, {
          status: 'failed',
          failureReason: reason,
          result: reason,
        });
        updated.push(pending.taskId);
      } catch {
        // ignore
      }
    }
  }
  return updated;
}

function failPlanRun(goalPlanStore, planId, message, {
  appendRunEvent,
  emit,
  summaryCode = 'runner_failed',
  source = 'runner',
  turnNumber = null,
} = {}) {
  const reason = typeof message === 'string' && message.trim()
    ? message.trim()
    : 'Goal Runner failed';
  const current = typeof goalPlanStore?.getPlan === 'function' ? goalPlanStore.getPlan(planId) : null;
  if (current && !TERMINAL_PLAN_STATUSES.has(current.status)) {
    goalPlanStore.setPlanStatus(planId, 'failed');
  }
  const failedTaskIds = markActiveLeafTasksFailed(goalPlanStore, planId, reason);
  if (typeof goalPlanStore?.setRunnerState === 'function') {
    goalPlanStore.setRunnerState(planId, {
      enabled: true,
      status: 'failed',
      intent: 'block',
      phase: 'blocked',
      lastError: reason,
      updatedAt: new Date().toISOString(),
    });
  }
  if (typeof appendRunEvent === 'function') {
    appendRunEvent(planId, {
      type: 'problem_found',
      summary: `Goal Runner failed: ${reason}`,
      payload: {
        summaryCode,
        message: reason,
        reason: source,
        ...(turnNumber == null ? {} : { turnNumber }),
        ...(failedTaskIds.length ? { failedTaskIds } : {}),
      },
    });
  }
  if (typeof emit === 'function') {
    emit('goalRunner:failed', { planId, error: reason, failedTaskIds });
  }
  return failedTaskIds;
}


function collectStringSet(values) {
  const refs = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    if (typeof value === 'string' && value.trim()) refs.add(value.trim());
  }
  return refs;
}

function collectKnownInvolvedFiles(plan, leafTasks = collectLeafTasks(plan)) {
  const files = collectStringSet(plan?.involvedFiles);
  for (const task of leafTasks) {
    for (const file of collectStringSet(task?.involvedFiles)) files.add(file);
  }
  return Array.from(files);
}

function hasCompletedExplorerReport(plan) {
  return (Array.isArray(plan?.runner?.explorers) ? plan.runner.explorers : [])
    .some((run) => run?.status === 'completed' && run.report);
}

function collectAutoSuccessCriteria(plan) {
  return (Array.isArray(plan?.successCriteria) ? plan.successCriteria : [])
    .filter((criterion) => (
      criterion &&
      typeof criterion === 'object' &&
      typeof criterion.kind === 'string' &&
      criterion.kind !== 'manual'
    ));
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function buildInspectScope(plan, knownFiles) {
  const include = [];
  if (typeof plan?.targetWorkspacePath === 'string' && plan.targetWorkspacePath.trim()) {
    include.push(plan.targetWorkspacePath.trim());
  }
  for (const item of collectStringSet(plan?.boundaries?.inScope)) include.push(item);
  for (const file of knownFiles) include.push(file);

  const exclude = Array.from(collectStringSet(plan?.boundaries?.outOfScope));
  return {
    ...(include.length > 0 ? { include: Array.from(new Set(include)).slice(0, 12) } : {}),
    ...(exclude.length > 0 ? { exclude: Array.from(new Set(exclude)).slice(0, 12) } : {}),
  };
}

export function createDeterministicExplorePlan(plan, { generatedAt = new Date().toISOString() } = {}) {
  const leafTasks = collectLeafTasks(plan);
  const knownFiles = collectKnownInvolvedFiles(plan, leafTasks);
  const autoCriteria = collectAutoSuccessCriteria(plan);
  const hasTargetWorkspace =
    typeof plan?.targetWorkspacePath === 'string' && plan.targetWorkspacePath.trim().length > 0;
  const hasCompletedExplorer = hasCompletedExplorerReport(plan);
  const missingTaskFileScope =
    leafTasks.length > 0 && leafTasks.some((task) => !Array.isArray(task.involvedFiles) || task.involvedFiles.length === 0);
  const complexEnoughForDeterministicInspect =
    hasTargetWorkspace || autoCriteria.length > 0 || leafTasks.length >= 4;
  const questions = [];

  if (!hasCompletedExplorer && complexEnoughForDeterministicInspect && missingTaskFileScope) {
    const scope = buildInspectScope(plan, knownFiles);
    const target = firstNonEmptyString(plan?.targetWorkspacePath, plan?.title, plan?.goal, 'the target workspace');
    questions.push({
      question: `Identify the primary files, modules, and existing implementation paths needed before acting on: ${target}`,
      reason: 'Deterministic inspect requires repository context and task-to-file grounding before act.',
      ...(Object.keys(scope).length > 0 ? { scope } : {}),
      budget: {
        maxToolCalls: INSPECT_EXPLORER_MAX_TOOL_CALLS,
        maxDurationMs: INSPECT_EXPLORER_MAX_DURATION_MS,
      },
    });
  }

  if (!hasCompletedExplorer && autoCriteria.length > 0 && knownFiles.length === 0) {
    const scope = buildInspectScope(plan, knownFiles);
    questions.push({
      question: 'Identify the read-only verification path for the automatic success criteria before acting.',
      reason: 'Deterministic inspect requires a verifiable test/check path before act.',
      ...(Object.keys(scope).length > 0 ? { scope } : {}),
      budget: {
        maxToolCalls: INSPECT_EXPLORER_MAX_TOOL_CALLS,
        maxDurationMs: INSPECT_EXPLORER_MAX_DURATION_MS,
      },
    });
  }

  return {
    requiredBeforeAct: questions.length > 0,
    questions,
    exitCriteria: [
      'primary modules/files identified or an Explorer report explains why they cannot be identified yet',
      'automatic verification path identified when automatic success criteria exist',
      'remaining unknowns are explicit and acceptable before act',
    ],
    generatedAt,
  };
}

function shouldStopForPlan(plan) {
  return !plan || TERMINAL_PLAN_STATUSES.has(plan.status) || plan.status === 'paused';
}

function runnerIsStopped(runner) {
  return !runner?.enabled || STOPPED_RUNNER_STATUSES.has(runner.status);
}

/**
 * 是否已获授权启动 Runner。Plan 继续使用批准准入；Goal 自驱契约使用 accepted_goal
 * 作为准入事实，不能继续复用 Plan 的审批门。
 *
 * 放行条件（任一）：
 * - workflowKind === 'goal_self_driven' 且 activation.kind === 'accepted_goal'：Goal 自驱契约。
 * - plan.approval.decision === 'approve'：协议层的权威批准事实（最符合「证据负责治理」）。
 * - status 已是 executing / paused：支持 Runner re-entry 与 resume，这些态只可能由既往批准启动而来。
 */
/**
 * intake 判别契约识别：activation.kind==='intake' 表示该自驱 goal 尚未确认是否为
 * 一个真实目标，Runner 在此阶段只做只读/问答/澄清，回合结束后再三选一收敛
 * （明确目标→升级、模糊→澄清、纯问答→静默移除）。见「方案乙」设计。
 */
function isIntakeContract(plan) {
  return plan?.activation?.kind === 'intake';
}

function isStartAuthorized(plan) {
  if (!plan) return false;
  if (goalPlanIsSelfDriven(plan)) {
    if (plan.activation?.kind === 'accepted_goal') return true;
    return plan.status === 'accepted' || plan.status === 'executing' || plan.status === 'paused';
  }
  if (plan.approval?.decision === 'approve') return true;
  return plan.status === 'executing' || plan.status === 'paused';
}

function hasCompletedProgress(plan) {
  const progress = plan?.progress;
  return progress && progress.total > 0 && progress.completed === progress.total;
}

/**
 * 统计计划内所有叶子任务（无 subtasks）的 evidenceRefs 总数。
 * 作为 no-progress 双信号之一：Evidence 增长视为有进展。
 */
function countLeafEvidence(plan) {
  const roots = Array.isArray(plan?.tasks) ? plan.tasks : [];
  let total = 0;
  const stack = [...roots];
  while (stack.length > 0) {
    const task = stack.pop();
    if (!task || typeof task !== 'object') continue;
    const subtasks = Array.isArray(task.subtasks) ? task.subtasks : [];
    if (subtasks.length > 0) {
      for (const child of subtasks) stack.push(child);
      continue;
    }
    if (Array.isArray(task.evidenceRefs)) total += task.evidenceRefs.length;
  }
  return total;
}

/**
 * 计算 no-progress 双信号基线：已完成任务数 + 叶子 Evidence 总数。
 * 任一信号相对上一轮增长，即视为「有进展」。
 */
function progressSignal(plan) {
  const completed = Number.isFinite(plan?.progress?.completed)
    ? Math.max(0, Math.trunc(plan.progress.completed))
    : 0;
  return { completed, evidence: countLeafEvidence(plan) };
}

function signalAdvanced(prev, next) {
  if (!prev) return true;
  return next.completed > prev.completed || next.evidence > prev.evidence;
}

function nextPhaseAfterTurn(phase) {
  switch (phase) {
    case 'orient':
      return 'inspect';
    case 'inspect':
      return 'plan_scaffold';
    case 'plan_scaffold':
      return 'act';
    case 'verify':
      return 'repair';
    case 'repair':
      return 'act';
    case 'blocked':
      return 'repair';
    case 'synthesize':
      return 'synthesize';
    case 'act':
    default:
      return 'act';
  }
}

function phaseForIntent(intent, fallback = 'act') {
  switch (intent) {
    case 'explore':
      return 'inspect';
    case 'verify':
      return 'verify';
    case 'synthesize':
      return 'synthesize';
    case 'block':
      return 'blocked';
    case 'execute':
      return 'act';
    default:
      return fallback;
  }
}

// ── 防偏航系统（见 goal-mode-ultrathink-workflow 设计文档第六、八章）──────────────
//
// Goal 模式允许 Agent 自主执行,但不允许自主改目标。以下为纯函数护栏,便于单测:
// - re-anchor:周期性重申原始目标+成功标准,频率自适应任务规模(设计文档开放问题6拍板)。
// - drift 检测:范围/文件/任务膨胀超阈值即判定漂移,交由 pump 暂停问人。
// - verification gate:完成前要求所有叶子任务已完成且带 Evidence,阻断"无证据的口头完成"。

const REANCHOR_MIN_INTERVAL = 2;
const REANCHOR_MAX_INTERVAL = 6;
/** 任务/文件相对基线的膨胀比阈值(超过即视为范围漂移)。 */
const DRIFT_INFLATION_RATIO = 2;
/** 允许的绝对增量下限(小规模计划避免比值误报:未超过该增量不算漂移)。 */
const DRIFT_MIN_ABSOLUTE_DELTA = 3;

/**
 * re-anchor 间隔:clamp(ceil(taskCount/3), 2, 6)。
 * 小任务不浪费、大任务防漂移(设计文档开放问题6)。
 */
export function computeReanchorInterval(taskCount) {
  const n = Number.isFinite(taskCount) ? Math.max(0, Math.trunc(taskCount)) : 0;
  const base = Math.ceil(n / 3);
  return Math.min(REANCHOR_MAX_INTERVAL, Math.max(REANCHOR_MIN_INTERVAL, base || REANCHOR_MIN_INTERVAL));
}

/**
 * 是否应在本轮 re-anchor。forced=true(如计划修订后、长 Explorer 批次返回后)立即触发;
 * 否则每 interval 轮触发一次(turnNumber 从 1 起)。
 */
export function shouldReanchor(turnNumber, interval, forced = false) {
  if (forced) return true;
  const t = Number.isFinite(turnNumber) ? Math.trunc(turnNumber) : 0;
  const step = Number.isFinite(interval) && interval > 0 ? Math.trunc(interval) : REANCHOR_MIN_INTERVAL;
  if (t <= 0) return false;
  return t % step === 0;
}

/** 计划范围快照:任务总数(含嵌套)+ 去重后的 involvedFiles 数。用于 drift 基线与比较。 */
export function computePlanScopeSnapshot(plan) {
  const roots = Array.isArray(plan?.tasks) ? plan.tasks : [];
  const files = new Set();
  let taskCount = 0;
  const stack = [...roots];
  while (stack.length > 0) {
    const task = stack.pop();
    if (!task || typeof task !== 'object') continue;
    taskCount += 1;
    if (Array.isArray(task.involvedFiles)) {
      for (const f of task.involvedFiles) if (typeof f === 'string' && f.trim()) files.add(f.trim());
    }
    const subtasks = Array.isArray(task.subtasks) ? task.subtasks : [];
    for (const child of subtasks) stack.push(child);
  }
  return { taskCount, fileCount: files.size };
}

/**
 * 范围漂移检测:相对基线,任务数或文件数膨胀既超过比值阈值(×DRIFT_INFLATION_RATIO)
 * 又超过绝对增量下限(+DRIFT_MIN_ABSOLUTE_DELTA)时判定漂移。两个条件同时满足才报,
 * 避免小规模计划因比值敏感而误报。
 */
export function detectPlanDrift(baseline, current) {
  const reasons = [];
  if (!baseline || !current) return { drifted: false, reasons };
  const check = (label, base, cur) => {
    const b = Number.isFinite(base) ? base : 0;
    const c = Number.isFinite(cur) ? cur : 0;
    const delta = c - b;
    if (delta >= DRIFT_MIN_ABSOLUTE_DELTA && c >= b * DRIFT_INFLATION_RATIO && b >= 1) {
      reasons.push(`${label} inflated from ${b} to ${c}`);
    }
  };
  check('task count', baseline.taskCount, current.taskCount);
  check('involved files', baseline.fileCount, current.fileCount);
  return { drifted: reasons.length > 0, reasons };
}

// 可自动验证的成功标准类型（与 goal-plan-store 的 AUTO_CRITERION_KINDS 对齐）。
// 这些 kind 的标准必须有 passed=true 且带 evidenceRef 的验证结果才放行完成；
// 'manual' 则降级为 pre-finish 人工确认，不在此硬门拦截。
const AUTO_VERIFIABLE_CRITERION_KINDS = new Set([
  'command',
  'test',
  'file-contains',
  'file-exists',
]);

function normalizeEvidenceRefSet(value) {
  if (!value) return null;
  const refs = value instanceof Set ? Array.from(value) : value;
  if (!Array.isArray(refs)) return null;
  return new Set(
    refs
      .filter((ref) => typeof ref === 'string' && ref.trim())
      .map((ref) => ref.trim()),
  );
}

function taskHasIndexedEvidence(task, indexedEvidenceRefs) {
  if (!indexedEvidenceRefs) return true;
  const refs = Array.isArray(task?.evidenceRefs) ? task.evidenceRefs : [];
  return refs.some((ref) => typeof ref === 'string' && indexedEvidenceRefs.has(ref.trim()));
}

function criterionEvidenceIsIndexed(evidenceRef, indexedEvidenceRefs) {
  if (!indexedEvidenceRefs) return true;
  return typeof evidenceRef === 'string' && indexedEvidenceRefs.has(evidenceRef.trim());
}

function collectManualCriteria(plan) {
  return (Array.isArray(plan?.successCriteria) ? plan.successCriteria : [])
    .filter((criterion) => criterion && typeof criterion === 'object')
    .filter((criterion) => !AUTO_VERIFIABLE_CRITERION_KINDS.has(criterion.kind))
    .filter((criterion) => typeof criterion.id === 'string' && criterion.id.trim());
}

function latestManualDodConfirmation(plan, manualCriterionIds) {
  const expected = new Set(manualCriterionIds);
  if (expected.size === 0) return null;
  return (Array.isArray(plan?.manualConfirmations) ? plan.manualConfirmations : [])
    .filter((confirmation) => confirmation?.kind === 'manual_dod')
    .filter((confirmation) => Array.isArray(confirmation.criterionIds))
    .filter((confirmation) => {
      const ids = new Set(
        confirmation.criterionIds
          .filter((id) => typeof id === 'string' && id.trim())
          .map((id) => id.trim()),
      );
      for (const id of expected) {
        if (!ids.has(id)) return false;
      }
      return true;
    })
    .sort((a, b) => String(b.decidedAt || '').localeCompare(String(a.decidedAt || '')))[0] ?? null;
}

/**
 * 完成前验证门:遍历所有叶子任务,要求全部 status==='completed' 且 evidenceRefs 非空。
 * 任一叶子未完成或缺 Evidence 即不放行完成,返回 { passed:false, unmet:[...] }。
 * 这是"完成以证据为准、不能仅凭口头声明"的机器化落地。
 *
 * DoD-as-Code 增强（见 goal-mode-ultrathink-workflow 设计文档）：
 * - 若计划声明了 successCriteria，则在叶子证据之外，追加对成功标准的机器化校验：
 *   非 manual 的标准（command/test/file-contains/file-exists）必须有一条 passed=true
 *   且带 evidenceRef 的 CriterionResult，否则计入 unmet（reason=criterion_*）。
 * - manual 标准不在此拦截（由 pre-finish 一次人工确认承接），但会体现在 warnings。
 * - 若成功标准全为 manual（无任何可自动验证项），返回 weakDoD=true 告警，提示 DoD
 *   缺乏可执行验证——不阻断完成（向后兼容纯字符串 DoD），但让上层可感知并提示补强。
 */
export function evaluateVerificationGate(plan, options = {}) {
  const indexedEvidenceRefs = normalizeEvidenceRefSet(options.indexedEvidenceRefs);
  const requireManualConfirmation = options.requireManualConfirmation === true;
  const roots = Array.isArray(plan?.tasks) ? plan.tasks : [];
  const unmet = [];
  const warnings = [];
  let leaves = 0;
  const stack = [...roots];
  while (stack.length > 0) {
    const task = stack.pop();
    if (!task || typeof task !== 'object') continue;
    const subtasks = Array.isArray(task.subtasks) ? task.subtasks : [];
    if (subtasks.length > 0) {
      for (const child of subtasks) stack.push(child);
      continue;
    }
    leaves += 1;
    const done = task.status === 'completed';
    const hasEvidence = Array.isArray(task.evidenceRefs) && task.evidenceRefs.length > 0;
    const hasIndexedEvidence = hasEvidence && taskHasIndexedEvidence(task, indexedEvidenceRefs);
    if (!done || !hasEvidence || !hasIndexedEvidence) {
      unmet.push({
        taskId: task.taskId ?? null,
        status: task.status ?? null,
        reason: !done
          ? 'not_completed'
          : !hasEvidence
            ? 'missing_evidence'
            : 'unindexed_evidence',
      });
    }
  }
  // 无叶子任务(空计划)不视为通过——完成需要有可验证的证据基础。
  if (leaves === 0) return { passed: false, unmet: [], warnings, reason: 'no_leaf_tasks' };

  // DoD-as-Code：成功标准校验（有声明才检查，向后兼容无 successCriteria 的旧计划）。
  const criteria = Array.isArray(plan?.successCriteria) ? plan.successCriteria : [];
  if (criteria.length > 0) {
    const resultById = new Map(
      (Array.isArray(plan?.criterionResults) ? plan.criterionResults : [])
        .filter((r) => r && typeof r.criterionId === 'string')
        .map((r) => [r.criterionId, r]),
    );
    let autoCount = 0;
    const manualCriteria = [];
    for (const criterion of criteria) {
      if (!criterion || typeof criterion !== 'object') continue;
      const kind = typeof criterion.kind === 'string' ? criterion.kind : 'manual';
      const criterionId = typeof criterion.id === 'string' ? criterion.id : null;
      if (AUTO_VERIFIABLE_CRITERION_KINDS.has(kind)) {
        autoCount += 1;
        const result = criterionId ? resultById.get(criterionId) : null;
        const passed = result?.passed === true;
        const hasRef = typeof result?.evidenceRef === 'string' && result.evidenceRef.trim();
        const hasIndexedRef = hasRef && criterionEvidenceIsIndexed(result.evidenceRef, indexedEvidenceRefs);
        if (!passed || !hasRef || !hasIndexedRef) {
          unmet.push({
            criterionId,
            kind,
            reason: !result
              ? 'criterion_unverified'
              : !passed
                ? 'criterion_failed'
                : !hasRef
                  ? 'criterion_missing_evidence'
                  : 'criterion_unindexed_evidence',
          });
        }
      } else {
        // manual 标准：不硬拦，转 pre-finish 人工确认，记 warning。
        if (criterionId) manualCriteria.push(criterion);
        warnings.push({ criterionId, kind, reason: 'manual_confirmation_required' });
      }
    }
    // 全 manual（无任何可自动验证项）：弱 DoD 告警——完成不阻断，但提示补强可执行验证。
    if (autoCount === 0) {
      warnings.push({ reason: 'weak_dod_all_manual' });
    }
    if (requireManualConfirmation && manualCriteria.length > 0) {
      const criterionIds = manualCriteria
        .map((criterion) => criterion.id)
        .filter((id) => typeof id === 'string' && id.trim());
      const confirmation = latestManualDodConfirmation(plan, criterionIds);
      const status = confirmation?.decision === 'approve'
        ? 'approved'
        : confirmation?.decision === 'reject'
          ? 'rejected'
          : confirmation?.decision === 'revise'
            ? 'revise'
            : 'missing';
      const manualConfirmation = {
        required: true,
        status,
        criterionIds,
        ...(confirmation?.confirmationId ? { confirmationId: confirmation.confirmationId } : {}),
      };
      if (status !== 'approved') {
        unmet.push({
          criterionId: criterionIds.join(','),
          kind: 'manual',
          reason: status === 'missing'
            ? 'manual_confirmation_required'
            : 'manual_confirmation_not_approved',
          manualConfirmation,
        });
      }
      return { passed: unmet.length === 0, unmet, warnings, manualConfirmation };
    }
  }

  return { passed: unmet.length === 0, unmet, warnings };
}

function collectVerificationEvidenceRefs(plan) {
  const refs = new Set();
  const stack = Array.isArray(plan?.tasks) ? [...plan.tasks] : [];
  while (stack.length > 0) {
    const task = stack.pop();
    if (!task || typeof task !== 'object') continue;
    if (Array.isArray(task.evidenceRefs)) {
      for (const ref of task.evidenceRefs) {
        if (typeof ref === 'string' && ref.trim()) refs.add(ref.trim());
      }
    }
    const subtasks = Array.isArray(task.subtasks) ? task.subtasks : [];
    for (const child of subtasks) stack.push(child);
  }
  for (const result of Array.isArray(plan?.criterionResults) ? plan.criterionResults : []) {
    if (typeof result?.evidenceRef === 'string' && result.evidenceRef.trim()) {
      refs.add(result.evidenceRef.trim());
    }
  }
  return [...refs];
}

function summarizeVerificationGate(gate) {
  if (gate?.passed) return 'Verification gate passed';
  if (gate?.reason === 'no_leaf_tasks') return 'Verification gate failed: no verifiable leaf tasks';
  const summary = Array.isArray(gate?.unmet)
    ? gate.unmet.map((u) => `${u.taskId ?? u.criterionId ?? '?'}:${u.reason}`).join('; ')
    : '';
  return `Verification gate failed${summary ? `: ${summary}` : ''}`;
}

export function createGoalRunner({
  goalPlanStore,
  chatRuntime,
  explorerRunner = null,
  verifierRunner = null,
  emitEvent = null,
  now = () => new Date().toISOString(),
  logger = console,
} = {}) {
  if (!goalPlanStore) throw new Error('createGoalRunner requires goalPlanStore');
  if (!chatRuntime || typeof chatRuntime.runGoalTurn !== 'function') {
    throw new Error('createGoalRunner requires chatRuntime.runGoalTurn');
  }

  const sessions = new Map();

  function emit(type, payload = {}) {
    if (typeof emitEvent !== 'function') return;
    try {
      emitEvent({ type, ...payload });
    } catch (error) {
      logger?.warn?.('[goal-runner] emitEvent failed:', error);
    }
  }

  /**
   * Runner 进度 patch 入口：高频计数/阶段更新统一走这里。
   * 实际写盘节流与 changeKind=runner-progress 分级由 goal-plan-store.setRunnerState 负责。
   */
  function scheduleRunnerPatch(planId, patch = {}) {
    if (!planId || typeof goalPlanStore?.setRunnerState !== 'function') return null;
    return goalPlanStore.setRunnerState(planId, patch);
  }

  function appendRunEvent(planId, event = {}) {
    if (typeof goalPlanStore.appendRunEvent !== 'function') return null;
    try {
      return goalPlanStore.appendRunEvent(planId, event);
    } catch (error) {
      logger?.warn?.('[goal-runner] appendRunEvent failed:', error);
      return null;
    }
  }

  function appendCheckpoint(planId, reason, plan = goalPlanStore.getPlan(planId)) {
    const nodeId = plan?.runner?.currentTaskId || plan?.runTrace?.activeNodeId;
    return appendRunEvent(planId, {
      type: 'checkpoint_created',
      ...(nodeId ? { nodeId, activeNodeId: nodeId } : {}),
      summary: `Checkpoint: ${reason}`,
      payload: {
        summaryCode: 'checkpoint_created',
        reason,
        phase: plan?.runner?.phase ?? null,
        runnerStatus: plan?.runner?.status ?? null,
        planStatus: plan?.status ?? null,
      },
    });
  }

  function collectIndexedEvidenceRefsForPlan(plan) {
    if (!plan || typeof goalPlanStore.listEvidenceIndex !== 'function') return null;
    const conversationId = typeof plan.conversationId === 'string' && plan.conversationId.trim()
      ? plan.conversationId.trim()
      : null;
    const refs = [];
    for (const record of goalPlanStore.listEvidenceIndex()) {
      if (!record || typeof record.evidenceRef !== 'string') continue;
      if (record.planId === plan.planId || (conversationId && record.conversationId === conversationId)) {
        refs.push(record.evidenceRef);
      }
    }
    return refs;
  }

  function evaluatePlanVerificationGate(plan) {
    return evaluateVerificationGate(plan, {
      indexedEvidenceRefs: collectIndexedEvidenceRefsForPlan(plan),
      requireManualConfirmation: goalPlanIsSelfDriven(plan),
    });
  }

  function gateNeedsManualDodConfirmation(gate) {
    const unmet = Array.isArray(gate?.unmet) ? gate.unmet : [];
    return gate?.manualConfirmation?.required === true
      && gate.manualConfirmation.status === 'missing'
      && unmet.length > 0
      && unmet.every((item) => item?.reason === 'manual_confirmation_required');
  }

  function blockForManualDodConfirmation(planId, plan, gate) {
    if (plan?.status === 'completed') goalPlanStore.setPlanStatus(planId, 'executing');
    const criterionIds = Array.isArray(gate?.manualConfirmation?.criterionIds)
      ? gate.manualConfirmation.criterionIds
      : [];
    goalPlanStore.setRunnerState(planId, {
      enabled: true,
      status: 'blocked',
      intent: 'verify',
      phase: 'blocked',
      blockedReason: 'manual_dod_confirmation_required',
      ...blockerPatch(plan, 'manual_dod_confirmation_required', { phase: 'blocked' }),
      updatedAt: now(),
    });
    appendRunEvent(planId, {
      type: 'problem_found',
      summary: 'Manual DoD confirmation is required before completion',
      payload: {
        summaryCode: 'manual_dod_confirmation_required',
        reason: 'manual_dod_confirmation_required',
        criterionIds,
      },
    });
    appendCheckpoint(planId, 'manual_dod_confirmation_required', goalPlanStore.getPlan(planId));
    emit('goalRunner:manualDodConfirmationRequired', {
      planId,
      criterionIds,
      warnings: gate?.warnings ?? [],
    });
    emit('goalRunner:blocked', {
      planId,
      reason: 'manual_dod_confirmation_required',
      criterionIds,
      manualDodConfirmationRequired: true,
    });
    return getState(planId);
  }

  function blockerPatch(plan, reason, { phase = 'blocked', occurrences = null } = {}) {
    const nowIso = now();
    const fingerprint = `${phase}:${reason}`;
    const previous = plan?.runner?.blockerAudit;
    const same = previous?.fingerprint === fingerprint;
    return {
      phase,
      blockerAudit: {
        fingerprint,
        reason,
        occurrences: Number.isFinite(occurrences)
          ? Math.max(1, Math.trunc(occurrences))
          : same
            ? Math.max(1, Math.trunc(previous.occurrences || 1)) + 1
            : 1,
        firstSeenAt: same && previous?.firstSeenAt ? previous.firstSeenAt : nowIso,
        lastSeenAt: nowIso,
      },
    };
  }

  function recordVerificationRun(plan, gate) {
    if (!plan || typeof goalPlanStore.recordVerifierRun !== 'function') return;
    try {
      goalPlanStore.recordVerifierRun(plan.planId, {
        target: { kind: 'plan' },
        status: gate?.passed ? 'passed' : 'failed',
        evidenceRefs: collectVerificationEvidenceRefs(plan),
        summary: summarizeVerificationGate(gate),
        failureReason: gate?.passed ? undefined : summarizeVerificationGate(gate),
      });
      appendRunEvent(plan.planId, {
        type: gate?.passed ? 'validation_passed' : 'validation_failed',
        summary: summarizeVerificationGate(gate),
        evidenceRefs: collectVerificationEvidenceRefs(plan),
        payload: {
          source: 'verification_gate',
          summaryCode: gate?.passed ? 'validation_passed' : 'validation_failed',
          passed: gate?.passed === true,
          unmet: Array.isArray(gate?.unmet) ? gate.unmet : [],
          warnings: Array.isArray(gate?.warnings) ? gate.warnings : [],
        },
      });
    } catch (error) {
      logger?.warn?.('[goal-runner] record verifier run failed:', error);
    }
  }

  async function runVerifierIfAvailable(plan, gate) {
    if (!gate?.passed) {
      recordVerificationRun(plan, gate);
      return { passed: false, reason: summarizeVerificationGate(gate), report: null };
    }
    if (!verifierRunner || typeof verifierRunner.runVerifier !== 'function') {
      recordVerificationRun(plan, gate);
      return { passed: true, reason: 'verification_gate_passed_without_verifier_runner', report: null };
    }
    const verifierRunId = `verifier:${plan.planId}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
    goalPlanStore.recordVerifierRun?.(plan.planId, {
      verifierRunId,
      target: { kind: 'plan' },
      status: 'running',
      summary: 'Verifier started',
    });
    emit('goalRunner:verifierStarted', { planId: plan.planId, verifierRunId });
    let report;
    try {
      report = await verifierRunner.runVerifier({
        plan,
        planId: plan.planId,
        verifierRunId,
        gate,
      });
    } catch (error) {
      const message = errorMessage(error);
      goalPlanStore.recordVerifierRun?.(plan.planId, {
        verifierRunId,
        target: { kind: 'plan' },
        status: 'failed',
        summary: message,
        failureReason: message,
        report: {
          passed: false,
          failedCriteria: [],
          missingEvidence: [],
          risks: [message],
          evidenceRefs: [],
          recommendedNextAction: 'repair',
        },
      });
      emit('goalRunner:verifierFailed', { planId: plan.planId, verifierRunId, error: message });
      return { passed: false, reason: message, report: null };
    }
    const failedCriteria = Array.isArray(report?.failedCriteria) ? report.failedCriteria : [];
    const missingEvidence = Array.isArray(report?.missingEvidence) ? report.missingEvidence : [];
    const risks = Array.isArray(report?.risks) ? report.risks : [];
    const evidenceRefs = Array.isArray(report?.evidenceRefs)
      ? report.evidenceRefs.filter((ref) => typeof ref === 'string' && ref.trim()).map((ref) => ref.trim())
      : [];
    const passed = report?.passed === true
      && failedCriteria.length === 0
      && missingEvidence.length === 0
      && evidenceRefs.length > 0;
    const summary = typeof report?.summary === 'string' && report.summary.trim()
      ? report.summary.trim()
      : passed
        ? 'Verifier passed'
        : 'Verifier failed';
    goalPlanStore.recordVerifierRun?.(plan.planId, {
      verifierRunId,
      target: { kind: 'plan' },
      status: passed ? 'passed' : 'failed',
      evidenceRefs,
      summary,
      failureReason: passed ? undefined : summary,
      report: {
        passed,
        failedCriteria,
        missingEvidence,
        risks,
        evidenceRefs,
        recommendedNextAction: report?.recommendedNextAction,
      },
    });
    emit(passed ? 'goalRunner:verifierCompleted' : 'goalRunner:verifierFailed', {
      planId: plan.planId,
      verifierRunId,
      ...(passed ? {} : { reason: summary }),
    });
    return { passed, reason: summary, report };
  }

  function getState(planId) {
    const plan = goalPlanStore.getPlan(planId);
    if (!plan) return null;
    return {
      planId: plan.planId,
      planStatus: plan.status,
      runner: plan.runner ?? null,
      progress: plan.progress ?? null,
    };
  }

  function getSession(planId) {
    return sessions.get(planId) ?? null;
  }

  async function waitForIdle(planId) {
    const session = getSession(planId);
    if (!session) return getState(planId);
    await session.promise;
    return getState(planId);
  }

  function schedulePump(planId) {
    const existing = getSession(planId);
    if (existing) return existing.promise;

    const session = { cancelled: false, promise: null };
    const promise = pump(planId, session)
      .catch((error) => {
        const message = errorMessage(error);
        logger?.warn?.('[goal-runner] pump failed:', error);
        failPlanRun(goalPlanStore, planId, message, {
          appendRunEvent,
          emit,
          summaryCode: 'runner_failed',
          source: 'pump',
        });
      })
      .finally(() => {
        if (sessions.get(planId) === session) sessions.delete(planId);
      });
    session.promise = promise;
    sessions.set(planId, session);
    return promise;
  }

  function initializeRunner(planId, options = {}) {
    const current = goalPlanStore.getPlan(planId);
    if (!current) return null;
    if (TERMINAL_PLAN_STATUSES.has(current.status)) return current;

    // 批准准入闸门：未获批准的 plan 不允许启动 Runner（边界由代码强制，不靠调用方自觉）。
    if (!isStartAuthorized(current)) {
      const reason = 'Goal Runner start blocked: plan is not approved';
      goalPlanStore.setRunnerState(planId, {
        enabled: false,
        status: 'blocked',
        intent: 'block',
        blockedReason: reason,
        updatedAt: now(),
      });
      emit('goalRunner:blocked', { planId, reason });
      return null;
    }

    const runner = current.runner ?? {};
    goalPlanStore.setPlanStatus(planId, 'executing');
    return goalPlanStore.setRunnerState(planId, {
      enabled: true,
      status: 'running',
      intent: options.intent ?? runner.intent ?? 'execute',
      currentTaskId: options.currentTaskId ?? runner.currentTaskId,
      phase: options.phase ?? runner.phase ?? 'orient',
      turnCount: toPositiveInteger(runner.turnCount, 0, { allowZero: true }),
      toolCallCount: toPositiveInteger(runner.toolCallCount, 0, { allowZero: true }),
      explorerCount: toPositiveInteger(runner.explorerCount, 0, { allowZero: true }),
      maxTurns: toPositiveInteger(options.maxTurns, toPositiveInteger(runner.maxTurns, DEFAULT_MAX_TURNS)),
      maxToolCalls: toPositiveInteger(
        options.maxToolCalls,
        toPositiveInteger(runner.maxToolCalls, DEFAULT_MAX_TOOL_CALLS),
      ),
      maxExplorers: toPositiveInteger(
        options.maxExplorers,
        toPositiveInteger(runner.maxExplorers, DEFAULT_MAX_EXPLORERS, { allowZero: true }),
        { allowZero: true },
      ),
      explorerConcurrency: Math.min(
        EXPLORER_CONCURRENCY_HARD_CAP,
        toPositiveInteger(
          options.explorerConcurrency,
          toPositiveInteger(runner.explorerConcurrency, DEFAULT_EXPLORER_CONCURRENCY),
        ),
      ),
      blockerAudit: null,
      blockedReason: undefined,
      lastError: undefined,
      updatedAt: now(),
    });
  }

  async function start(planId, options = {}) {
    // start 是多入口的 kick（plan change、chat outcome、IPC），必须以活跃 session 为幂等边界。
    // 否则重复 kick 会反复写 action_started，写入本身又可能触发新的 change 回调。
    if (getSession(planId)) return getState(planId);
    const initialized = initializeRunner(planId, options);
    if (!initialized) return null;
    appendRunEvent(planId, {
      type: 'action_started',
      summary: 'Goal Runner started',
      payload: {
        summaryCode: 'runner_started',
        intent: initialized.runner?.intent ?? null,
        phase: initialized.runner?.phase ?? null,
      },
    });
    emit('goalRunner:started', { planId });
    const promise = schedulePump(planId);
    if (options.awaitIdle) await promise;
    return getState(planId);
  }

  async function resume(planId, options = {}) {
    const plan = goalPlanStore.getPlan(planId);
    if (!plan) return null;
    const canResumeVerificationBlock =
      plan.status === 'completed'
      && plan.runner?.status === 'blocked'
      && plan.runner?.intent === 'verify';
    const canResumeFailedRun = plan.status === 'failed';
    if (TERMINAL_PLAN_STATUSES.has(plan.status) && !canResumeVerificationBlock && !canResumeFailedRun) return null;
    const runnerPatch = {
      intent: options.intent ?? (canResumeFailedRun ? 'execute' : plan.runner?.intent) ?? 'execute',
      phase: options.phase ?? (plan.runner?.phase === 'blocked' ? 'repair' : plan.runner?.phase) ?? 'orient',
      updatedAt: now(),
    };
    if (plan.status === 'completed') {
      goalPlanStore.setRunnerState(planId, {
        ...runnerPatch,
        enabled: true,
        status: 'running',
        blockerAudit: null,
        blockedReason: undefined,
        lastError: undefined,
      });
    } else {
      goalPlanStore.resumeRunner(planId, runnerPatch);
    }
    appendRunEvent(planId, {
      type: 'goal_resumed',
      summary: 'Goal Runner resumed',
      payload: {
        summaryCode: 'runner_resumed',
        checkpointNodeId: plan.runTrace?.lastCheckpointNodeId ?? null,
        previousRunnerStatus: plan.runner?.status ?? null,
        previousPhase: plan.runner?.phase ?? null,
      },
    });
    emit('goalRunner:resumed', { planId });
    const promise = schedulePump(planId);
    if (options.awaitIdle) await promise;
    return getState(planId);
  }

  function pause(planId, reason = 'paused') {
    const session = getSession(planId);
    if (session) session.cancelled = true;
    const plan = goalPlanStore.getPlan(planId);
    if (!plan) return null;
    if (!TERMINAL_PLAN_STATUSES.has(plan.status)) goalPlanStore.setPlanStatus(planId, 'paused');
    goalPlanStore.setRunnerState(planId, {
      enabled: true,
      status: 'paused',
      intent: 'block',
      blockedReason: reason,
      updatedAt: now(),
    });
    appendRunEvent(planId, {
      type: 'goal_paused',
      summary: `Goal Runner paused: ${reason}`,
      payload: { summaryCode: 'runner_paused', reason },
    });
    appendCheckpoint(planId, reason, goalPlanStore.getPlan(planId));
    emit('goalRunner:paused', { planId, reason });
    return getState(planId);
  }

  function clear(planId, reason = 'cleared') {
    const session = getSession(planId);
    if (session) session.cancelled = true;
    const plan = goalPlanStore.getPlan(planId);
    if (!plan) return null;
    goalPlanStore.setPlanStatus(planId, 'cancelled');
    goalPlanStore.setRunnerState(planId, {
      enabled: false,
      status: 'idle',
      intent: 'block',
      blockedReason: reason,
      updatedAt: now(),
    });
    emit('goalRunner:cleared', { planId, reason });
    return getState(planId);
  }

  async function runExplorerBatch({
    planId,
    requests,
    batchId,
    session,
    missingRunnerReason = 'Explorer requested but no explorer runner is available',
    afterExplorePhase = 'plan_scaffold',
  }) {
    const current = goalPlanStore.getPlan(planId);
    if (!current) return { terminal: true, state: null };
    if (!Array.isArray(requests) || requests.length === 0) return { terminal: false };

    if (!explorerRunner || typeof explorerRunner.runExplorer !== 'function') {
      goalPlanStore.setRunnerState(planId, {
        enabled: true,
        status: 'blocked',
        intent: 'explore',
        blockedReason: missingRunnerReason,
        ...blockerPatch(current, 'explorer_runner_missing', { phase: 'blocked' }),
        updatedAt: now(),
      });
      emit('goalRunner:blocked', {
        planId,
        reason: missingRunnerReason,
      });
      return { terminal: true, state: getState(planId) };
    }

    const concurrency = Math.min(
      EXPLORER_CONCURRENCY_HARD_CAP,
      toPositiveInteger(current?.runner?.explorerConcurrency, DEFAULT_EXPLORER_CONCURRENCY),
    );
    goalPlanStore.setRunnerState(planId, {
      enabled: true,
      status: 'exploring',
      intent: 'explore',
      phase: 'inspect',
      updatedAt: now(),
    });
    const dispatched = [];
    for (const request of requests) {
      const withRequest = goalPlanStore.dispatchExplorer(planId, { ...request, batchId });
      const explorer = withRequest?.runner?.explorers?.at(-1);
      if (!explorer) continue;
      dispatched.push({ explorer, plan: withRequest });
      emit('goalRunner:explorerStarted', {
        planId,
        explorerId: explorer.explorerId,
        question: explorer.request?.question,
      });
    }

    let explorerToolCalls = 0;
    let cursor = 0;
    const runOne = async ({ explorer, plan: withRequest }) => {
      try {
        const report = await explorerRunner.runExplorer({
          plan: withRequest,
          planId,
          runner: withRequest.runner,
          explorer,
        });
        explorerToolCalls += countToolCalls(report);
        goalPlanStore.reportExplorer(planId, explorer.explorerId, {
          ...report,
          status: report?.status || 'completed',
        });
        emit('goalRunner:explorerCompleted', { planId, explorerId: explorer.explorerId });
      } catch (error) {
        const message = errorMessage(error);
        goalPlanStore.reportExplorer(planId, explorer.explorerId, {
          status: 'failed',
          failureReason: message,
          summary: message,
          confidence: 'low',
        });
        emit('goalRunner:explorerFailed', { planId, explorerId: explorer.explorerId, error: message });
      }
    };
    const worker = async () => {
      while (true) {
        if (session.cancelled) return;
        const index = cursor;
        cursor += 1;
        if (index >= dispatched.length) return;
        await runOne(dispatched[index]);
      }
    };
    const poolSize = Math.max(1, Math.min(concurrency, dispatched.length));
    if (poolSize > 0) {
      await Promise.all(Array.from({ length: poolSize }, () => worker()));
    }
    if (session.cancelled) return { terminal: true, state: getState(planId) };
    if (explorerToolCalls > 0) {
      const afterExplore = goalPlanStore.getPlan(planId);
      scheduleRunnerPatch(planId, {
        toolCallCount:
          toPositiveInteger(afterExplore?.runner?.toolCallCount, 0, { allowZero: true }) + explorerToolCalls,
        updatedAt: now(),
      });
    }
    goalPlanStore.setRunnerState(planId, {
      enabled: true,
      status: 'running',
      intent: 'execute',
      phase: afterExplorePhase,
      updatedAt: now(),
    });
    return { terminal: false };
  }

  async function pump(planId, session) {
    // no-progress 双信号基线，仅存活于本次 pump 闭包内：
    // resume 会重新拉起 pump，计数自然清零（既往不咎语义）。
    let lastSignal = null;
    let noProgressStreak = 0;
    // 防偏航:范围基线在本次 pump 首轮建立,后续轮次相对它检测 drift（任务/文件膨胀）。
    let scopeBaseline = null;
    let reanchorInterval = REANCHOR_MIN_INTERVAL;
    while (!session.cancelled) {
      // 用 let：verification gate 未过时会把状态从 completed 拨回 executing 并重取 plan
      // （见下方 "plan = goalPlanStore.getPlan(...)"），const 会在该路径抛 TypeError。
      let plan = goalPlanStore.getPlan(planId);
      if (!plan) return null;

      if (plan.status === 'completed' || hasCompletedProgress(plan)) {
        const gate = evaluatePlanVerificationGate(plan);
        if (!gate.passed) {
          if (gateNeedsManualDodConfirmation(gate)) {
            return blockForManualDodConfirmation(planId, plan, gate);
          }
          await runVerifierIfAvailable(plan, gate);
          const summary = gate.reason === 'no_leaf_tasks'
            ? 'no verifiable leaf tasks'
            : gate.unmet
              .map((u) => `${u.taskId ?? u.criterionId ?? '?'}:${u.reason}`)
              .join('; ');
          if (plan.status === 'completed') goalPlanStore.setPlanStatus(planId, 'executing');
          goalPlanStore.setRunnerState(planId, {
            enabled: true,
            status: 'blocked',
            intent: 'verify',
            blockedReason: `Verification gate failed: ${summary}`,
            ...blockerPatch(plan, 'verification_gate_failed', { phase: 'blocked' }),
            updatedAt: now(),
          });
          appendCheckpoint(planId, 'verification_gate_failed', goalPlanStore.getPlan(planId));
          emit('goalRunner:blocked', {
            planId,
            reason: 'verification_gate_failed',
            unmet: gate.unmet,
            warnings: gate.warnings ?? [],
          });
          return getState(planId);
        }
        if (Array.isArray(gate.warnings) && gate.warnings.length > 0) {
          emit('goalRunner:verificationWarnings', {
            planId,
            warnings: gate.warnings,
          });
        }
        const verifier = await runVerifierIfAvailable(plan, gate);
        if (!verifier.passed) {
          if (plan.status === 'completed') goalPlanStore.setPlanStatus(planId, 'executing');
          goalPlanStore.setRunnerState(planId, {
            enabled: true,
            status: 'blocked',
            intent: 'verify',
            blockedReason: `Verifier failed: ${verifier.reason}`,
            ...blockerPatch(plan, 'verifier_failed', { phase: 'repair' }),
            updatedAt: now(),
          });
          appendRunEvent(planId, {
            type: 'self_correction',
            summary: `Verifier failed; returning to repair: ${verifier.reason}`,
            payload: { summaryCode: 'self_correction', reason: verifier.reason, trigger: 'validation_failed', correction: 'repair' },
          });
          appendCheckpoint(planId, 'verifier_failed', goalPlanStore.getPlan(planId));
          emit('goalRunner:blocked', {
            planId,
            reason: 'verifier_failed',
            detail: verifier.reason,
          });
          return getState(planId);
        }
        if (plan.status !== 'completed') goalPlanStore.setPlanStatus(planId, 'completed');
        goalPlanStore.setRunnerState(planId, {
          enabled: false,
          status: 'completed',
          intent: 'synthesize',
          phase: 'synthesize',
          updatedAt: now(),
        });
        appendRunEvent(planId, {
          type: 'goal_completed',
          summary: 'Goal Runner completed after verification passed',
          payload: { summaryCode: 'goal_completed' },
          evidenceRefs: collectVerificationEvidenceRefs(goalPlanStore.getPlan(planId)),
        });
        emit('goalRunner:completed', { planId });
        return getState(planId);
      }
      if (plan.status === 'failed') {
        // stream/runtime 瞬时失败可能留下 plan.failed，但叶子事实可能已恢复。
        // 先按任务树重算：仅当叶子事实仍支持 failed 时才真正停机。
        const recoveredStatus = derivePlanStatus(plan.status, plan.tasks);
        if (recoveredStatus !== 'failed') {
          if (recoveredStatus === 'completed') {
            goalPlanStore.setPlanStatus(planId, 'completed');
            goalPlanStore.setRunnerState(planId, {
              enabled: false,
              status: 'completed',
              intent: 'verify',
              phase: 'synthesize',
              updatedAt: now(),
            });
            emit('goalRunner:completed', { planId });
            return getState(planId);
          }
          goalPlanStore.setPlanStatus(planId, 'executing');
          plan = goalPlanStore.getPlan(planId) || { ...plan, status: 'executing' };
        } else {
          goalPlanStore.setRunnerState(planId, {
            enabled: false,
            status: 'failed',
            intent: 'block',
            phase: 'blocked',
            updatedAt: now(),
          });
          appendRunEvent(planId, {
            type: 'problem_found',
            summary: 'Goal Runner stopped because plan status is failed',
            payload: { summaryCode: 'runner_stopped_failed', reason: 'plan_failed' },
          });
          emit('goalRunner:failed', { planId });
          return getState(planId);
        }
      }
      if (shouldStopForPlan(plan)) return getState(planId);

      const runner = plan.runner ?? {};
      if (runnerIsStopped(runner)) return getState(planId);

      // 次数/轮次预算熔断已移除：Runner 不再因 turnCount/toolCallCount 达到上限
      // 而进入 budget_exhausted。turnCount/toolCallCount/maxTurns/maxToolCalls 仅
      // 保留为展示用计数，不再作为停止判定。防失控依赖下方 no-progress 双信号护栏
      // 以及权限拒绝 / blocked / Evidence 回写等其它护栏。

      // no-progress 双信号护栏：基于截至目前的累计进展（含上一轮 runGoalTurn
      // 写入与 explorer 回填）。连续 DEFAULT_NO_PROGRESS_LIMIT 轮无增长即阻塞。
      const signal = progressSignal(plan);
      if (signalAdvanced(lastSignal, signal)) {
        noProgressStreak = 0;
        if (plan.runner?.blockerAudit) {
          goalPlanStore.setRunnerState(planId, {
            blockerAudit: null,
            blockedReason: undefined,
            lastError: undefined,
            updatedAt: now(),
          });
        }
      } else {
        noProgressStreak += 1;
      }
      lastSignal = signal;
      if (noProgressStreak >= DEFAULT_NO_PROGRESS_LIMIT) {
        goalPlanStore.setRunnerState(planId, {
          enabled: true,
          status: 'blocked',
          intent: 'block',
          blockedReason: 'no_progress',
          ...blockerPatch(plan, 'no_progress', {
            phase: 'blocked',
            occurrences: noProgressStreak,
          }),
          updatedAt: now(),
        });
        appendRunEvent(planId, {
          type: 'problem_found',
          summary: 'Goal Runner detected no progress',
          payload: { summaryCode: 'no_progress', reason: 'no_progress', noProgressStreak },
        });
        appendCheckpoint(planId, 'no_progress', goalPlanStore.getPlan(planId));
        emit('goalRunner:blocked', { planId, reason: 'no_progress' });
        return getState(planId);
      }

      const turnNumber = runner.turnCount + 1;

      // ── 防偏航:drift 检测 + 周期性 re-anchor（设计文档第六章）─────────────
      // 首轮建立范围基线;后续轮相对基线检测任务/文件膨胀,漂移即暂停问人,不带病推进。
      const scopeNow = computePlanScopeSnapshot(plan);
      if (!scopeBaseline) {
        scopeBaseline = scopeNow;
        reanchorInterval = computeReanchorInterval(scopeNow.taskCount);
      } else {
        const drift = detectPlanDrift(scopeBaseline, scopeNow);
        if (drift.drifted) {
          goalPlanStore.setRunnerState(planId, {
            enabled: true,
            status: 'blocked',
            intent: 'block',
            blockedReason: `scope_drift: ${drift.reasons.join('; ')}`,
            ...blockerPatch(plan, 'scope_drift', { phase: 'blocked' }),
            updatedAt: now(),
          });
          appendRunEvent(planId, {
            type: 'problem_found',
            summary: `Scope drift detected: ${drift.reasons.join('; ')}`,
            payload: { summaryCode: 'scope_drift', reason: drift.reasons.join('; '), reasons: drift.reasons },
          });
          appendCheckpoint(planId, 'scope_drift', goalPlanStore.getPlan(planId));
          emit('goalRunner:blocked', { planId, reason: 'scope_drift', reasons: drift.reasons });
          return getState(planId);
        }
      }
      // re-anchor:达到自适应间隔即发信号,提示续推上下文重申原始目标+成功标准。
      // 计数以 turnNumber 为准;实际重申文案由 goal-runner-source 的续推上下文承载。
      const reanchor = shouldReanchor(turnNumber, reanchorInterval);
      if (reanchor) {
        emit('goalRunner:reanchor', { planId, turnNumber, interval: reanchorInterval });
      }

      if ((runner.phase ?? 'orient') === 'inspect') {
        const inspectPlan = createDeterministicExplorePlan(plan, { generatedAt: now() });
        goalPlanStore.setRunnerState(planId, {
          inspectPlan,
          updatedAt: now(),
        });
        emit('goalRunner:inspectPlan', {
          planId,
          turnNumber,
          requiredBeforeAct: inspectPlan.requiredBeforeAct,
          questionCount: inspectPlan.questions.length,
        });
        if (inspectPlan.requiredBeforeAct) {
          const exploreResult = await runExplorerBatch({
            planId,
            requests: inspectPlan.questions,
            batchId: `${planId}:inspect:${turnNumber}`,
            session,
            missingRunnerReason: 'Deterministic inspect requires Explorer before act, but no explorer runner is available',
            afterExplorePhase: 'plan_scaffold',
          });
          if (exploreResult.terminal) return exploreResult.state;
          continue;
        }
      }

      goalPlanStore.setRunnerState(planId, {
        enabled: true,
        status: 'running',
        intent: runner.intent ?? 'execute',
        phase: runner.phase ?? 'orient',
        reanchor,
        updatedAt: now(),
      });
      appendRunEvent(planId, {
        type: 'step_started',
        summary: `Goal Runner turn ${turnNumber} started`,
        payload: {
          summaryCode: 'turn_started',
          turnNumber,
          phase: runner.phase ?? 'orient',
          reanchor,
        },
      });
      emit('goalRunner:tickStarted', { planId, turnNumber, reanchor });

      let result;
      try {
        result = await chatRuntime.runGoalTurn({
          plan,
          runner,
          planId,
          turnNumber,
          explorerRunner,
        });
      } catch (error) {
        const message = errorMessage(error);
        failPlanRun(goalPlanStore, planId, message, {
          appendRunEvent,
          emit,
          summaryCode: 'turn_failed',
          source: 'runGoalTurn',
          turnNumber,
        });
        return getState(planId);
      }

      const afterTurnPlan = goalPlanStore.getPlan(planId);
      if (!afterTurnPlan) return null;
      const afterTurnRunner = afterTurnPlan.runner ?? {};
      // turnCount 仅作预算/tick 计数（maxTurns 熔断依据），每 tick +1。
      // 展示用的「工具」计数（toolCallCount）已由 runGoalTurn 注入的实时 sink 在工具
      // 派发处拥有并累加，这里不再重复累加，避免双重计数。
      scheduleRunnerPatch(planId, {
        turnCount: toPositiveInteger(afterTurnRunner.turnCount, 0, { allowZero: true }) + 1,
        updatedAt: now(),
      });
      appendRunEvent(planId, {
        type: 'step_completed',
        summary: `Goal Runner turn ${turnNumber} completed`,
        payload: {
          summaryCode: 'turn_completed',
          turnNumber,
          terminalStatus: result?.terminalStatus ?? null,
          intent: result?.intent ?? null,
          completed: result?.completed === true,
          blocked: result?.blocked === true,
        },
      });

      const latest = goalPlanStore.getPlan(planId);
      const latestRunner = latest?.runner ?? null;
      emit('goalRunner:tickCompleted', {
        planId,
        turnNumber,
        planStatus: latest?.status ?? null,
        runnerStatus: latestRunner?.status ?? null,
      });

      if (!latest || session.cancelled) return getState(planId);
      if (latest.status === 'paused' || latestRunner?.status === 'paused') return getState(planId);
      if (latest.status === 'completed' || hasCompletedProgress(latest)) continue;
      if (latest.status === 'failed') continue;

      const exploreRequests = normalizeExploreRequests(result);
      if (exploreRequests.length > 0) {
        const exploreResult = await runExplorerBatch({
          planId,
          requests: exploreRequests,
          batchId: `${planId}:t${turnNumber}`,
          session,
        });
        if (exploreResult.terminal) return exploreResult.state;
        continue;
      }

      // intake 判别收敛（方案乙）：intake 契约在一个回合结束后三选一。
      // - explore 已在上方处理：intake 轮允许只读调查，continue 进入下一判别轮。
      // - 明确目标：模型调用 goal_create_plan → upsertGoalContract 已把本契约原地升级为
      //   accepted_goal（activation.kind 不再是 intake），本块不触发，落入正常自驱推进。
      // - 模糊澄清：模型调用 request_user_input → 交由下方通用 requestedUserInput 分支
      //   保留契约并等待用户回复（intake 契约不删）。
      // - 纯问答/咨询：既未升级、也未提问、回合正常结束 → 静默移除 intake 契约并终结 Runner，
      //   还原成普通聊天体验（D2=deletePlan、D3=判别期面板静默）。
      // 出错/中止的 intake 回合不在此误删，交由下方通用错误分支按失败处理。
      if (isIntakeContract(latest)) {
        const intakeTurnFailed = result?.failed
          || result?.blocked
          || result?.terminalStatus === 'error'
          || result?.terminalStatus === 'aborted';
        if (!result?.requestedUserInput && !intakeTurnFailed) {
          appendRunEvent(planId, {
            type: 'intake_resolved',
            summary: 'Intake resolved as inquiry; goal contract removed',
            payload: { summaryCode: 'intake_resolved_inquiry', resolution: 'inquiry', turnNumber },
          });
          emit('goalRunner:intakeResolved', {
            planId,
            turnNumber,
            resolution: 'inquiry',
          });
          if (sessions.get(planId) === session) sessions.delete(planId);
          goalPlanStore.deletePlan(planId);
          return null;
        }
      }

      if (result?.requestedUserInput) {
        const reason = result.blockedReason || 'requested_user_input';
        goalPlanStore.setRunnerState(planId, {
          enabled: true,
          status: 'blocked',
          intent: 'block',
          phase: 'blocked',
          blockedReason: reason,
          ...blockerPatch(latest, reason, { phase: 'blocked' }),
          updatedAt: now(),
        });
        appendRunEvent(planId, {
          type: 'problem_found',
          summary: `Goal Runner requested user input: ${reason}`,
          payload: { summaryCode: 'requested_user_input', reason, requestedUserInput: true },
        });
        appendCheckpoint(planId, reason, goalPlanStore.getPlan(planId));
        emit('goalRunner:blocked', { planId, reason, requestedUserInput: true });
        return getState(planId);
      }

      if (result?.terminalStatus === 'error') {
        const message = result.failureReason || 'Goal Runner turn stream failed';
        failPlanRun(goalPlanStore, planId, message, {
          appendRunEvent,
          emit,
          summaryCode: 'stream_failed',
          source: 'stream_error',
          turnNumber,
        });
        return getState(planId);
      }

      if (result?.terminalStatus === 'aborted') {
        const reason = result.blockedReason || 'Goal Runner turn aborted';
        goalPlanStore.setRunnerState(planId, {
          enabled: true,
          status: 'blocked',
          intent: 'block',
          phase: 'blocked',
          blockedReason: reason,
          ...blockerPatch(latest, reason, { phase: 'blocked' }),
          updatedAt: now(),
        });
        appendRunEvent(planId, {
          type: 'network_interrupted',
          summary: reason,
          payload: { summaryCode: 'network_interrupted', reason, terminalStatus: 'aborted' },
        });
        appendCheckpoint(planId, reason, goalPlanStore.getPlan(planId));
        emit('goalRunner:blocked', { planId, reason });
        return getState(planId);
      }

      if (result?.continue === false) {
        goalPlanStore.setRunnerState(planId, {
          enabled: true,
          status: 'idle',
          intent: result.intent ?? latestRunner?.intent ?? 'execute',
          phase: phaseForIntent(result.intent ?? latestRunner?.intent, latestRunner?.phase ?? 'act'),
          updatedAt: now(),
        });
        emit('goalRunner:tickCompleted', { planId, turnNumber, continue: false });
        return getState(planId);
      }

      if (result?.blocked) {
        const reason = result.blockedReason || 'Goal Runner blocked';
        const observedPhase = latestRunner?.phase ?? runner.phase ?? 'act';
        const auditPatch = blockerPatch(latest, reason, { phase: observedPhase });
        if (auditPatch.blockerAudit.occurrences < DEFAULT_BLOCKER_AUDIT_LIMIT) {
          goalPlanStore.setRunnerState(planId, {
            enabled: true,
            status: 'running',
            intent: result.intent ?? latestRunner?.intent ?? 'execute',
            phase: observedPhase,
            blockerAudit: auditPatch.blockerAudit,
            blockedReason: undefined,
            updatedAt: now(),
          });
          emit('goalRunner:blockerObserved', {
            planId,
            reason,
            occurrences: auditPatch.blockerAudit.occurrences,
            threshold: DEFAULT_BLOCKER_AUDIT_LIMIT,
          });
          continue;
        }
        goalPlanStore.setRunnerState(planId, {
          enabled: true,
          status: 'blocked',
          intent: 'block',
          phase: 'blocked',
          blockedReason: reason,
          blockerAudit: auditPatch.blockerAudit,
          updatedAt: now(),
        });
        appendRunEvent(planId, {
          type: 'problem_found',
          summary: `Goal Runner blocked: ${reason}`,
          payload: { summaryCode: 'runner_blocked', reason, occurrences: auditPatch.blockerAudit.occurrences },
        });
        appendCheckpoint(planId, reason, goalPlanStore.getPlan(planId));
        emit('goalRunner:blocked', { planId, reason, occurrences: auditPatch.blockerAudit.occurrences });
        return getState(planId);
      }

      if (result?.failed) {
        const message = result.failureReason || 'Goal Runner failed';
        failPlanRun(goalPlanStore, planId, message, {
          appendRunEvent,
          emit,
          summaryCode: 'runner_failed',
          source: 'runtime_failed',
          turnNumber,
        });
        return getState(planId);
      }

      // 完成前验证门(设计文档第八章):模型声明完成时,要求所有叶子任务均已完成且带 Evidence。
      // 这比旧的 hasCompletedProgress（仅需部分进展）更严,机器化落地「完成以证据为准」,
      // 阻断「无证据的口头完成」。任一叶子未达标即转 blocked/verify,附未达标清单。
      if (result?.completed) {
        goalPlanStore.setRunnerState(planId, {
          enabled: true,
          status: 'running',
          intent: 'verify',
          phase: 'verify',
          updatedAt: now(),
        });
        const gate = evaluatePlanVerificationGate(latest);
        if (!gate.passed) {
          if (gateNeedsManualDodConfirmation(gate)) {
            return blockForManualDodConfirmation(planId, latest, gate);
          }
          await runVerifierIfAvailable(latest, gate);
          const summary = gate.reason === 'no_leaf_tasks'
            ? 'no verifiable leaf tasks'
            // 兼容两类未达标项：叶子任务（taskId）与成功标准（criterionId）。
            : gate.unmet
              .map((u) => `${u.taskId ?? u.criterionId ?? '?'}:${u.reason}`)
              .join('; ');
          goalPlanStore.setRunnerState(planId, {
            enabled: true,
            status: 'blocked',
            intent: 'verify',
            blockedReason: `Verification gate failed: ${summary}`,
            ...blockerPatch(latest, 'verification_gate_failed', { phase: 'blocked' }),
            updatedAt: now(),
          });
          emit('goalRunner:blocked', {
            planId,
            reason: 'verification_gate_failed',
            unmet: gate.unmet,
            warnings: gate.warnings ?? [],
          });
          return getState(planId);
        }
        // 完成放行，但若存在弱 DoD / 待人工确认的 manual 标准，透出告警供上层提示。
        if (Array.isArray(gate.warnings) && gate.warnings.length > 0) {
          emit('goalRunner:verificationWarnings', {
            planId,
            warnings: gate.warnings,
          });
        }
        const verifier = await runVerifierIfAvailable(latest, gate);
        if (!verifier.passed) {
          if (latest.status === 'completed') goalPlanStore.setPlanStatus(planId, 'executing');
          goalPlanStore.setRunnerState(planId, {
            enabled: true,
            status: 'blocked',
            intent: 'verify',
            blockedReason: `Verifier failed: ${verifier.reason}`,
            ...blockerPatch(latest, 'verifier_failed', { phase: 'repair' }),
            updatedAt: now(),
          });
          emit('goalRunner:blocked', {
            planId,
            reason: 'verifier_failed',
            detail: verifier.reason,
          });
          return getState(planId);
        }
        goalPlanStore.setPlanStatus(planId, 'completed');
        goalPlanStore.setRunnerState(planId, {
          enabled: false,
          status: 'completed',
          intent: 'synthesize',
          phase: 'synthesize',
          updatedAt: now(),
        });
        emit('goalRunner:completed', { planId });
        return getState(planId);
      }

      goalPlanStore.setRunnerState(planId, {
        enabled: true,
        status: 'running',
        intent: latestRunner?.intent ?? 'execute',
        phase: nextPhaseAfterTurn(latestRunner?.phase ?? runner.phase ?? 'orient'),
        updatedAt: now(),
      });
    }
    return getState(planId);
  }

  return {
    start,
    pause,
    resume,
    clear,
    getState,
    waitForIdle,
  };
}

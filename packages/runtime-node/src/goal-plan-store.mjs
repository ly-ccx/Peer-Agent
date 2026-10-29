import { createGoalPlanCheckpoints } from "./goal-plan-checkpoints.mjs";
import { createGoalPlanEvidence } from "./goal-plan-evidence.mjs";
import { createGoalPlanEvents } from "./goal-plan-events.mjs";
import { goalFileVersion as fileVersion } from './goal-plan-files.mjs';

import {
  appendJsonl,
  mergeEvidenceIndexRecords,
  normalizeEvidenceIndexRecord,
  readEvidenceRecordsFromTail,
  readJson,
  readJsonl,
  readJsonlCached,
  writeGoalChangeEvent,
  writeJsonAtomic,
  writeJsonl,
} from './goal-plan-files.mjs';
import {
  BLOCKED,
  CONFIRMATION_DECISIONS,
  DEFAULT_EXPLORER_CONCURRENCY,
  DEFAULT_SELF_DRIVEN_POLICY,
  EXPLORER_STATUSES,
  LEAF_TERMINAL_STATUSES,
  PLAN_TERMINAL_STATUSES,
  TERMINAL_CANCEL,
  TERMINAL_FAIL,
  TERMINAL_OK,
  aggregateProgress,
  applyGoalTimingTransition,
  canConsumeRequestedUserInput,
  derivePlanStatus,
  isPreviewReviewPendingLeaf,
  normalizeActivation,
  normalizeConversationId,
  normalizeCriterionResults,
  normalizeDelegationOrigin,
  normalizeDeliveryBinding,
  normalizeDeliveryHandoff,
  normalizeEvidenceRefList,
  normalizeExecutionPolicy,
  normalizeExplorerReport,
  normalizeExplorerRun,
  normalizeGoalTiming,
  normalizeManualConfirmation,
  normalizeManualConfirmations,
  normalizeOptionalName,
  normalizeOptionalString,
  normalizePlan,
  normalizeQualityReview,
  normalizeRunEvent,
  normalizeRunTrace,
  normalizeRunnerState,
  normalizeStringArray,
  normalizeSuccessCriteria,
  normalizeTargetBranchSource,
  normalizeVerifierRun,
  normalizeWorkflowKind,
  normalizeWorkspacePath,
  runnerWaitsOnUser,
} from './goal-plan-domain.mjs';
export {
  canConsumeRequestedUserInput,
  runnerWaitsOnUser,
  goalPlanWaitsOnPreviewReview,
  isPreviewReviewPendingLeaf,
  goalPlanWaitsOnUser,
  derivePlanStatus,
  aggregateProgress,
  applyGoalTimingTransition,
  normalizeGoalTiming,
} from './goal-plan-domain.mjs';
import { criterionSourceRevision } from './project-agent/criterion-review.mjs';
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync, unlinkSync, watch } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathOf } from './data-store.mjs';
import { attachWorkspaceHeadBinding } from './goal-delivery-binding.mjs';
import { normalizeGoalCheckpoint, validateGoalCheckpoint } from '@peer-agent/runtime-core';
import {
  assertAcceptanceCloseGate,
  collectHeldEvidenceRefs,
  DESKTOP_PREVIEW_CAPABILITY,
  isAcceptanceClosePatch,
} from '@peer-agent/protocol';
import { normalizeVisualRepair, hasActiveGoalRepair } from './goal-visual-repair.mjs';
import { projectUiCompletion } from './goal-ui-completion.mjs';
import { classifyUiDeliveryIntake } from './goal-intake-ui-delivery.mjs';
/**
 * Runner 人在回路 / 暂停态：即使 plan 仍为 executing 也停表。
 * exploring / compacting_context 等系统侧工作不停表。
 */
const RUNNER_PAUSE_STATUSES = new Set(['paused', 'waiting_user', 'blocked', 'budget_exhausted']);
const RUNNER_ACTIVE_STATUSES = new Set([
  'running',
  'compacting_context',
  'resuming_after_compaction',
  'exploring',
]);

/**
 * 按最终 Runner 状态校正 executing Goal 的 active segment。
 *
 * 这是 Runner → timing → 持久化的统一边界：调用方即使绕过 setRunnerState
 * 直接持久化 runner，也不能留下「活跃状态停表」或「暂停状态仍计时」的不一致。
 * 函数按最终状态幂等校正，因此也能在下一次写入时修复历史脏状态；只从
 * 当前写入时刻重新开表，不回填无法证明的历史有效时长。
 *
 * @param {object|null|undefined} prevTiming
 * @param {string|undefined} planStatus
 * @param {string|undefined} runnerStatus
 * @param {string} [nowIso]
 * @returns {object|undefined}
 */
function reconcileGoalTimingWithRunner(prevTiming, planStatus, runnerStatus, nowIso) {
  let timing = normalizeGoalTiming(prevTiming);
  if (planStatus !== 'executing') return timing;

  if (RUNNER_PAUSE_STATUSES.has(runnerStatus)) {
    if (timing?.activeSegmentStartedAt) {
      timing = applyGoalTimingTransition(timing, 'executing', 'paused', nowIso);
    }
    return timing;
  }

  if (RUNNER_ACTIVE_STATUSES.has(runnerStatus) && !timing?.activeSegmentStartedAt) {
    return applyGoalTimingTransition(timing, 'paused', 'executing', nowIso);
  }

  return timing;
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
 *    终态（completed / failed / cancelled）时，把顶层推进到终态——含任一 failed → 'failed'，
 *    否则 completed + cancelled → 'completed'。waiting_user 不算终态；空计划不收尾。
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
function hasRunningLeaf(nodes) {
  for (const t of nodes || []) {
    const children = Array.isArray(t.subtasks) ? t.subtasks : [];
    if (children.length > 0) {
      if (hasRunningLeaf(children)) return true;
      continue;
    }
    if (t.status === 'running') return true;
  }
  return false;
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
// 可自动验证的标准类型（完成门要求带 passed=true 的 CriterionResult）。
const AUTO_CRITERION_KINDS = new Set(['command', 'test', 'file-contains', 'file-exists']);

function collectManualCriterionIds(plan) {
  return (Array.isArray(plan?.successCriteria) ? plan.successCriteria : [])
    .filter((criterion) => criterion && typeof criterion === 'object')
    .filter((criterion) => !AUTO_CRITERION_KINDS.has(criterion.kind))
    .map((criterion) => (typeof criterion.id === 'string' ? criterion.id.trim() : ''))
    .filter(Boolean);
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

const ACTIVE_PLAN_STATUSES = new Set(['drafting', 'awaiting_approval', 'approved', 'accepted', 'executing', 'paused', 'interrupted', 'failed']);

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

/** Remaining unfinished leaves are only close-denied-until-review. Host review can run. */
export function listPreviewReviewPendingLeaves(plan) {
  const roots = Array.isArray(plan?.tasks) ? plan.tasks : [];
  const pending = [];
  const stack = [...roots];
  while (stack.length > 0) {
    const task = stack.pop();
    if (!task || typeof task !== 'object') continue;
    const subtasks = Array.isArray(task.subtasks) ? task.subtasks : [];
    if (subtasks.length > 0) {
      for (const child of subtasks) stack.push(child);
      continue;
    }
    if (isPreviewReviewPendingLeaf(task) && typeof task.taskId === 'string' && task.taskId) pending.push(task.taskId);
  }
  return pending;
}

/**
 * intake → accepted_goal 升级时清掉流错误 / 收敛残留的「等用户」。
 * 真执行中的 request_user_input 不会走这条升级缝，不能在这里清。
 */
function runnerPatchForAcceptedGoalUpgrade(runner) {
  if (!runner || typeof runner !== 'object') return undefined;
  const hasInterruption = runner.interruption != null;
  const leftoverUserWait = runner.status === 'waiting_user'
    && runnerWaitsOnUser(runner);
  const leftoverFailedRun = runner.status === 'failed' || runner.status === 'blocked';
  if (!hasInterruption && !leftoverUserWait) return undefined;
  const next = {
    ...runner,
    interruption: null,
  };
  if (leftoverUserWait) {
    next.status = 'idle';
    next.intent = 'execute';
    next.phase = 'orient';
    next.blockedReason = undefined;
    next.waitingOnUser = undefined;
  }
  // 陈旧流中断把 runner 钉在 failed/blocked。升级是新的接受决策，必须重新武装，
  // 否则 auto-start 闸门看到 failed 会拒绝，出现 turnCount=0 停摆。
  if (hasInterruption && leftoverFailedRun) {
    next.enabled = true;
    next.status = 'running';
    next.intent = 'execute';
    next.phase = 'orient';
    next.blockedReason = undefined;
  }
  return next;
}

export function createGoalPlanStore({
  storeDir = pathOf('goalPlans'),
  onChange,
  readWorkspaceHead,
  readUiDelivery,
  onUiDeliveryRequired,
  onPlanCompleted,
} = {}) {
  const { supersedeContextCheckpoint, markContextCheckpointConsumed, markContextCompactionPersisted, commitContextCheckpoint, prepareContextCheckpoint } = createGoalPlanCheckpoints({ getPlan, persist, appendRunEvent });

  const { findEvidenceIndexRecords, assertEvidenceRefIndexed, evidenceRecordMatchesPlan, readEvidenceIndex, assertAnyEvidenceRefIndexed, hasDesktopPreviewEvidence, recordEvidenceRefs } = createGoalPlanEvidence({ storeDir, getActivePlanByConversation });

  const { subscribeChanges, notifyChanged, publishPersistedChange, setOnChange } = createGoalPlanEvents({ storeDir, onChange });

  // Intake 期 UI 交付判定（B-level seam）：goal 契约建立/修订/intake 升级时对
  // 契约文本跑纯函数分类（goal-intake-ui-delivery），命中则回调宿主。Desktop 把
  // 回调接到 ui-delivery-authority.requirePreview，视觉验证完成门因此在开工前
  // 即武装（而不是等模型自己开预览后才被动立起）。无回调宿主（TUI/无预览）
  // 时为 no-op；分类异常绝不阻塞契约写入。
  function armUiDeliveryVerification(plan, meta = {}) {
    if (typeof onUiDeliveryRequired !== 'function' || !plan) return;
    if (plan.activation?.kind === 'intake') return;
    try {
      const verdict = classifyUiDeliveryIntake({
        title: plan.title,
        goal: plan.goal,
        tasks: plan.tasks,
        successCriteria: plan.successCriteria,
      });
      if (verdict?.required === true) onUiDeliveryRequired(plan, verdict, meta);
    } catch { /* 判定失败不影响契约本身 */ }
  }
  // 只读暴露武装状态：供 System Context source 渲染「视觉验证门已武装」事实，
  // 也供测试断言。读取失败一律视为未武装（fail-open 只影响提示，不影响完成门）。
  function isUiDeliveryRequired(plan) {
    if (typeof readUiDelivery !== 'function' || !plan) return false;
    try {
      return readUiDelivery(plan)?.required === true;
    } catch {
      return false;
    }
  }
  // UI projection may call a host port that still reads getPlan (artifact identity).
  // Re-enter with the candidate already in hand; never recurse through authority.
  const uiCompletionGuarding = new Set();
  const guardUiCompletion = (plan) => {
    if (!plan?.planId) return projectUiCompletion(plan, readUiDelivery, readEvidenceIndex);
    if (uiCompletionGuarding.has(plan.planId)) return plan;
    uiCompletionGuarding.add(plan.planId);
    try {
      return projectUiCompletion(plan, readUiDelivery, readEvidenceIndex);
    } finally {
      uiCompletionGuarding.delete(plan.planId);
    }
  };
  const indexFile = path.join(storeDir, 'index.jsonl'); // { mtimeMs, size, planIds: Set<string> }
  /** listPlans 归一化结果缓存：index mtime+size 未变时复用，避免反复 normalize×N。 */
  let listPlansCache = null; // { mtimeMs, size, plans }
  function invalidateListPlansCache() {
    listPlansCache = null;
  }
  function writeIndex(items) {
    writeJsonl(indexFile, items);
    invalidateListPlansCache();
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
  // 同时把磁盘写入合并到 1s 窗口，降低 CLI 后台跑时跨进程 .changes.jsonl 放大。
  const runnerProgressOverlay = new Map();
  const runnerProgressVersions = new Map();
  const runnerProgressTimers = new Map();
  // soft progress：同进程广播 100ms；跨进程写盘 1s。硬状态仍即时。
  const runnerProgressNotifyTimers = new Map();
  const RUNNER_PROGRESS_PERSIST_MS = 1000;
  const RUNNER_PROGRESS_NOTIFY_MS = 100;

  function clearRunnerProgressState(planId) {
    if (planId) {
      runnerProgressOverlay.delete(planId);
      runnerProgressVersions.delete(planId);
      const timer = runnerProgressTimers.get(planId);
      if (timer) {
        clearTimeout(timer);
        runnerProgressTimers.delete(planId);
      }
      const notifyTimer = runnerProgressNotifyTimers.get(planId);
      if (notifyTimer) {
        clearTimeout(notifyTimer);
        runnerProgressNotifyTimers.delete(planId);
      }
      return;
    }
    for (const timer of runnerProgressTimers.values()) clearTimeout(timer);
    runnerProgressTimers.clear();
    for (const timer of runnerProgressNotifyTimers.values()) clearTimeout(timer);
    runnerProgressNotifyTimers.clear();
    runnerProgressOverlay.clear();
    runnerProgressVersions.clear();
  }

  function currentRunnerProgress(planId) {
    const overlay = runnerProgressOverlay.get(planId);
    if (!overlay) return null;
    if (runnerProgressVersions.get(planId) !== fileVersion(planFile(planId))) {
      clearRunnerProgressState(planId);
      return null;
    }
    return overlay;
  }

  function flushRunnerProgressPersist(planId, { notify = false } = {}) {
    const timer = runnerProgressTimers.get(planId);
    if (timer) {
      clearTimeout(timer);
      runnerProgressTimers.delete(planId);
    }
    const overlay = currentRunnerProgress(planId);
    if (!overlay) return null;
    const normalized = normalizePlan(overlay);
    const next = guardUiCompletion({
      ...normalized,
      status: hasActiveGoalRepair(normalized) && derivePlanStatus(normalized.status, normalized.tasks) === TERMINAL_OK
        ? 'executing' : derivePlanStatus(normalized.status, normalized.tasks),
      progress: aggregateProgress(normalized.tasks),
    });
    writeJsonAtomic(planFile(next.planId), next);
    syncIndex(next);
    // 落盘后保留 overlay 内容一致；完整 persist 路径会清 overlay。
    runnerProgressOverlay.set(planId, next);
    runnerProgressVersions.set(planId, fileVersion(planFile(planId)));
    publishPersistedChange('persist', next.planId, {
      conversationId: next.conversationId ?? null,
      changeKind: 'runner-progress',
      runner: next.runner ?? null,
      notifyLocal: notify,
    });
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

  /** soft progress 广播合并：同一 plan 100ms 窗口只推最新 runner 快照。 */
  function scheduleRunnerProgressNotify(planId, conversationId) {
    if (runnerProgressNotifyTimers.has(planId)) return;
    const timer = setTimeout(() => {
      runnerProgressNotifyTimers.delete(planId);
      const plan = getPlan(planId);
      if (!plan) return;
      notifyChanged('persist', planId, {
        conversationId: conversationId ?? plan.conversationId ?? null,
        changeKind: 'runner-progress',
        runner: plan.runner ?? null,
      });
    }, RUNNER_PROGRESS_NOTIFY_MS);
    runnerProgressNotifyTimers.set(planId, timer);
  }

  function planFile(id) {
    return path.join(storeDir, `${id}.json`);
  }

  function readIndex() {
    // §12 性能治理：listPlans 热路径走 stat 缓存（mtimeMs+size 未变时复用解析结果）。
    return readJsonlCached(indexFile);
  }

  function toMeta(plan) {
    return {
      planId: plan.planId,
      title: plan.title,
      status: plan.status,
      workflowKind: plan.workflowKind,
      conversationId: plan.conversationId ?? null,
      threadId: plan.threadId ?? null,
      // 工作区归属随轻量索引持久化，列表消费者可先筛候选再读取详情。
      originWorkspacePath: plan.originWorkspacePath ?? null,
      targetWorkspacePath: plan.targetWorkspacePath ?? null,
      targetRepoId: plan.targetRepoId ?? null,
      targetBranch: plan.targetBranch ?? null,
      targetBranchSource: plan.targetBranchSource ?? null,
      version: plan.version,
      percent: plan.progress?.percent ?? 0,
      createdAt: plan.createdAt,
      updatedAt: plan.updatedAt,
      // TaskOverview 可在 hydrate 前排除已验收/祖父化 completed。
      resultAcceptance: plan.resultAcceptance ?? null,
      resultAcceptedAt: plan.resultAcceptedAt ?? null,
      resultAcceptedBy: plan.resultAcceptedBy ?? null,
      // 候选筛要在 hydrate 前看见真实交回态，避免交回中的已验收被提前丢掉。
      deliveryHandoff: plan.deliveryHandoff ?? null,
    };
  }

  function syncIndex(plan) {
    const index = readIndex().filter((m) => m.planId !== plan.planId);
    index.push(toMeta(plan));
    writeIndex( index);
  }

  function persist(plan, options = {}) {
    // progress 始终由子任务聚合派生，写入前强制重算覆盖（不可手填）。
    // timing 在 status 实际迁移时推进；同状态写入仅规范化，不重复开关 segment。
    // 调用方通常传入 { ...plan, status: next }，所以 prevStatus 必须取磁盘旧值
    // （或 options 显式覆盖），不能用入参上的新 status。
    const existing = plan?.planId ? (() => {
      try {
        const file = planFile(plan.planId);
        if (!existsSync(file)) return null;
        return normalizePlan(JSON.parse(readFileSync(file, 'utf8')));
      } catch {
        return null;
      }
    })() : null;
    const prevStatus = options.prevStatus ?? existing?.status;
    const prevTiming = options.prevTiming ?? existing?.timing;
    const shouldAttachBinding = Boolean(
      plan?.targetWorkspacePath
      && !existing?.deliveryBinding
      && (
        !existing
        || existing.targetWorkspacePath !== plan.targetWorkspacePath
        || (existing.activation?.kind === 'intake' && plan.activation?.kind !== 'intake')
      ),
    );
    const normalized = normalizePlan(
      shouldAttachBinding
        ? attachWorkspaceHeadBinding(plan, { readWorkspaceHead })
        : plan,
    );
    // 已停止且尚未消费的执行中断是独立于叶子任务的可恢复挂起事实（ADR 73），
    // 普通 persist 不能把 interrupted 重新派生为 completed。叶子或 Runner 一旦
    // 继续执行，计划必须回到 executing，不能再钉在 interrupted 上；仅当工作已停
    // 且叶子尚未全部成功时，才保持 interrupted。可恢复中断在重试预算内仍由
    // running Runner 持有行动权，只记录失败尝试，不能因为 interruption Evidence
    // 的存在就把整个计划降级为失败终态；真实叶子失败仍由 derivePlanStatus 派生为 failed。
    const derivedStatus = options.preserveStatus
      ? normalized.status
      : derivePlanStatus(normalized.status, normalized.tasks);
    const hasUnconsumedInterruption = Boolean(
      normalized.runner?.interruption &&
      !(normalized.runner.interruption.recoverable === true && normalized.runner.status === 'running'),
    );
    const runnerWorkContinues = RUNNER_ACTIVE_STATUSES.has(normalized.runner?.status);
    const workContinues = runnerWorkContinues || hasRunningLeaf(normalized.tasks);
    // 未消费中断只拦住「还没做完、也没在跑」的计划。已经 completed 之后再写过期
    // interruption，不能把计划钉回 interrupted。但计划当时已经是 interrupted 时，
    // 最后一片叶子 completed 也不得把可恢复挂起洗成 completed（ADR 73 / 38.17）。
    // pending 未开工不算继续执行。
    const verificationBlocked = normalized.runner?.status === 'blocked'
      && normalized.runner?.intent === 'verify';
    const repairOpen = hasActiveGoalRepair(normalized);
    const keepLiveInterruption = hasUnconsumedInterruption
      && (derivedStatus !== TERMINAL_OK || prevStatus === 'interrupted');
    const candidateStatus = (verificationBlocked || repairOpen) && derivedStatus === TERMINAL_OK
      ? 'executing'
      : keepLiveInterruption
        ? (workContinues ? 'executing' : 'interrupted')
        : derivedStatus;
    const nextStatus = guardUiCompletion({ ...normalized, status: candidateStatus }).status;
    const nowIso = normalized.updatedAt || new Date().toISOString();
    // Delegated leaf completion does not end its host-owned verification pump.
    // Legacy standalone plans retain their terminal runner correction.
    const nextRunner = PLAN_TERMINAL_STATUSES.has(nextStatus)
      && RUNNER_ACTIVE_STATUSES.has(normalized.runner?.status)
      && !normalized.runner?.interruption
      && !(normalized.delegationOrigin && nextStatus === TERMINAL_OK)
      ? {
        ...normalized.runner,
        status: nextStatus === TERMINAL_FAIL ? 'failed' : 'idle',
        intent: nextStatus === TERMINAL_FAIL ? 'block' : (normalized.runner.intent || 'verify'),
        phase: nextStatus === TERMINAL_FAIL ? 'blocked' : 'verify',
        updatedAt: nowIso,
      }
      : normalized.runner;
    const planTiming = applyGoalTimingTransition(
      prevTiming,
      prevStatus,
      nextStatus,
      nowIso,
    );
    const timing = reconcileGoalTimingWithRunner(
      planTiming,
      nextStatus,
      nextRunner?.status,
      nowIso,
    );
    const next = {
      ...normalized,
      // 默认按叶子事实派生；preserveStatus 用于显式 setPlanStatus（如 stream_error → failed），
      // 避免瞬时失败态在同一次写入中被立刻恢复。后续 recordTaskEvidence 会重新派生。
      status: nextStatus,
      ...(nextRunner ? { runner: nextRunner } : {}),
      progress: aggregateProgress(normalized.tasks),
      ...(timing ? { timing } : {}),
    };
    // 终态 / 非执行态时若 timing 已清空 open segment 且历史无 timing，不强制写空对象
    if (!timing && Object.prototype.hasOwnProperty.call(next, 'timing')) {
      delete next.timing;
    }
    // 完整写盘优先：清掉 runner-progress 节流状态，避免旧计数回写覆盖。
    clearRunnerProgressState(next.planId);
    writeJsonAtomic(planFile(next.planId), next);
    syncIndex(next);
    publishPersistedChange('persist', next.planId, {
      conversationId: next.conversationId ?? null,
      changeKind: options.changeKind ?? 'persist',
      ...(options.runner ? { runner: options.runner } : {}),
    });
    // 完成迁移（非 completed → completed）一次性通知宿主：desktop 据此落盘
    // 验收报告（goal-reports）。回调异常绝不影响已写盘的完成态。
    if (nextStatus === TERMINAL_OK && prevStatus !== TERMINAL_OK && typeof onPlanCompleted === 'function') {
      try {
        onPlanCompleted(next, { prevStatus });
      } catch { /* 报告失败不影响完成态 */ }
    }
    return next;
  }

  function activeMeta(meta) {
    return !isInactivePlan(meta);
  }

  function projectUiMeta(meta) {
    if (meta.status !== TERMINAL_OK || typeof readUiDelivery !== 'function') return meta;
    const plan = getPlan(meta.planId);
    return plan ? { ...meta, status: plan.status } : { ...meta, status: 'executing' };
  }

  function readPlanMetadata() {
    let stat = null;
    try {
      stat = statSync(indexFile);
    } catch {
      listPlansCache = null;
      return [];
    }
    if (
      listPlansCache &&
      listPlansCache.mtimeMs === stat.mtimeMs &&
      listPlansCache.size === stat.size
    ) {
      return listPlansCache.plans;
    }
    const plans = readIndex()
      .map(normalizePlan)
      .filter((m) => m && activeMeta(m))
      .sort((a, b) =>
        String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')),
      );
    listPlansCache = {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      plans,
    };
    return plans;
  }

  // Discovery only; current plan state and completion still go through getPlan.
  let planMetadataCache = null;
  function listPlanMetadata() {
    let info;
    try { info = statSync(indexFile, { bigint: true }); }
    catch { planMetadataCache = null; return []; }
    const version = `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
    if (planMetadataCache?.version === version) return structuredClone(planMetadataCache.plans);
    const plans = readJsonl(indexFile).map(normalizePlan).filter(meta => meta && activeMeta(meta));
    const next = statSync(indexFile, { bigint: true });
    if (`${next.dev}:${next.ino}:${next.size}:${next.mtimeNs}:${next.ctimeNs}` !== version) throw new Error('plan_metadata_read_changed');
    planMetadataCache = Buffer.byteLength(JSON.stringify(plans)) <= 8 * 1024 * 1024 ? { version, plans } : null;
    return structuredClone(plans);
  }
  function listPlans() { return readPlanMetadata().map(projectUiMeta); }

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

  function selectPlanMetas(metas, options = {}) {
    const candidateFilter = typeof options?.candidateFilter === 'function'
      ? options.candidateFilter
      : null;
    const limit = Number.isFinite(options?.limit) && options.limit > 0
      ? Math.floor(options.limit)
      : 0;
    const selected = [];
    for (const meta of metas) {
      if (candidateFilter) {
        try {
          if (candidateFilter(meta) !== true) continue;
        } catch {
          // 筛选器异常时宁可多 hydrate，也不能把工作台任务漏掉。
        }
      }
      selected.push(meta);
    }
    return limit > 0 ? selected.slice(0, limit) : selected;
  }

  function listPlanDetails(options = {}) {
    return selectPlanMetas(listPlans(), options).map(hydratePlanMeta).filter(Boolean);
  }

  /**
   * 仅 hydrate 与指定工作区直接关联的计划。
   *
   * 新索引行可直接按 origin/targetWorkspacePath 筛选；旧索引行没有工作区字段时，
   * 只回退读取这些 legacy 详情，避免升级后漏掉历史计划。
   */
  function listPlanDetailsByWorkspace(workspacePath, options = {}) {
    const normalizePath = (value) => typeof value === 'string'
      ? value.trim().replace(/[/\\]+$/, '').toLowerCase()
      : '';
    const wanted = normalizePath(workspacePath);
    if (!wanted) return listPlanDetails(options);
    const candidateFilter = typeof options?.candidateFilter === 'function'
      ? options.candidateFilter
      : null;
    const limit = Number.isFinite(options?.limit) && options.limit > 0
      ? Math.floor(options.limit)
      : 0;

    const index = readIndex();
    let indexChanged = false;
    const indexedMatches = [];
    const details = [];
    const nextIndex = index.map((rawMeta) => {
      const meta = normalizePlan(rawMeta);
      if (!meta || !activeMeta(meta)) return rawMeta;

      const hasWorkspaceIndex = Object.hasOwn(rawMeta, 'originWorkspacePath')
        || Object.hasOwn(rawMeta, 'targetWorkspacePath');
      const indexedWorkspacePath = normalizePath(
        meta.originWorkspacePath ?? meta.targetWorkspacePath,
      );
      if (hasWorkspaceIndex && indexedWorkspacePath !== wanted) return rawMeta;
      if (candidateFilter) {
        try {
          if (candidateFilter(meta) !== true) return rawMeta;
        } catch {
          // 筛选器异常时继续，避免漏掉工作区任务。
        }
      }

      if (hasWorkspaceIndex) {
        indexedMatches.push(meta);
        return rawMeta;
      }

      // 旧索引没有工作区字段时才回退读详情，用来补齐并判断归属。
      const plan = hydratePlanMeta(meta);
      if (!plan) return rawMeta;
      const planWorkspacePath = normalizePath(
        plan.originWorkspacePath ?? plan.targetWorkspacePath,
      );
      if (planWorkspacePath === wanted) details.push(plan);
      indexChanged = true;
      return {
        ...rawMeta,
        originWorkspacePath: plan.originWorkspacePath ?? null,
        targetWorkspacePath: plan.targetWorkspacePath ?? null,
      };
    });

    indexedMatches.sort((a, b) =>
      String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')),
    );
    const remaining = limit > 0 ? Math.max(0, limit - details.length) : indexedMatches.length;
    const selectedIndexed = limit > 0 ? indexedMatches.slice(0, remaining) : indexedMatches;
    for (const meta of selectedIndexed) {
      const plan = hydratePlanMeta(meta);
      if (!plan) continue;
      const planWorkspacePath = normalizePath(
        plan.originWorkspacePath ?? plan.targetWorkspacePath,
      );
      if (planWorkspacePath === wanted) details.push(plan);
    }

    // 旧索引只在首次按工作区读取时补齐一次，后续切换即可直接跳过无关详情文件。
    if (indexChanged) writeIndex( nextIndex);
    return details;
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

  function isUnacceptedCompletedPlan(plan) {
    return plan?.status === 'completed'
      && !(
        plan.resultAcceptance
        && typeof plan.resultAcceptance.acceptedAt === 'string'
        && plan.resultAcceptance.acceptedAt.trim()
      );
  }

  /**
   * 同会话最近一条未验收 completed 计划。新开 Goal 时它应作为旧计划留下，
   * 不能被自动取消。
   */
  function getUnacceptedCompletedPlanByConversation(conversationId) {
    const normalizedConversationId = normalizeConversationId(conversationId);
    if (normalizedConversationId === null) return null;
    const plans = listPlanDetailsByConversation(normalizedConversationId)
      .filter(isUnacceptedCompletedPlan)
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    return plans[0] ?? null;
  }

  function getPlan(planId) {
    const overlay = currentRunnerProgress(planId);
    if (overlay) return guardUiCompletion(normalizePlan(overlay));
    return guardUiCompletion(normalizePlan(readJson(planFile(planId))));
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
   * - 活跃态计划照旧收尾/作废。
   * - 已完成（含未验收）计划是同会话下的既有 Goal：新开 Goal 时必须留下，
   *   不能标成 cancelled 从面板上抹掉。
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
      const plan = getPlan(meta.planId);
      if (!plan) continue;

      // 已完成（含未验收）计划是同会话下的既有 Goal，新开 Goal 时必须留下。
      if (isUnacceptedCompletedPlan(plan) || plan.status === 'completed') continue;
      // 仅处理仍在飞的活跃态；failed / cancelled 不触碰。
      if (!isActivePlan(plan)) continue;

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
      const nextPlan = {
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
      };
      persist(nextPlan);
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

  function sanitizePlanTitle(rawTitle, goalText) {
    const raw = typeof rawTitle === 'string' ? rawTitle.replace(/\s+/g, ' ').trim() : '';
    const goal = typeof goalText === 'string' ? goalText.replace(/\s+/g, ' ').trim() : '';
    const isAck = (value) => /^(好|好的|行|可以|认可|ok|okay|yes|yep|lgtm)([,，、\s].*)?$|^(好|好的)?[,，、\s]*就这么做[.!！。…]*$|^(就这么做)[.!！。…]*$/i.test(value || '');
    const isCmd = (value) => /^[>$]\s/.test(value || '') || (/\b(tsc|npm|pnpm|yarn|node)\b/i.test(value || '') && (value || '').includes('/'));
    // 用户首句/长 goal 常被误塞进 title。标题应是短意图名，不能回退成 goal 截断。
    const looksLikeRawUtterance = (value) => {
      if (!value) return false;
      if (value.length > 40) return true;
      if (/[?？]$/.test(value) || /(?:吧|吗|呢)$/.test(value)) return true;
      // 多子句口语长句（逗号/顿号较多）不像「动词+对象」短标题。
      if (value.length > 18 && (value.match(/[，,、；;]/g) || []).length >= 1 && /[。.!！]/.test(value) === false) {
        return /(?:不应该|能不能|可不可以|怎么|如何|一下|这个|那种)/.test(value);
      }
      return false;
    };
    const isGoalEcho = (value) => {
      if (!value || !goal) return false;
      if (value === goal) return true;
      // 旧逻辑会把 goal 截成 `${goal.slice(0, 24)}…`；只把这类截断回声当坏标题，
      // 不要把「恰好是 goal 前缀」的合法短意图名误杀。
      if (!(value.endsWith('…') || value.endsWith('...'))) return false;
      const stripped = value.replace(/[.…]+$/g, '').trim();
      return Boolean(stripped) && goal.startsWith(stripped);
    };
    let title = raw;
    if (
      !title
      || isAck(title)
      || isCmd(title)
      || looksLikeRawUtterance(title)
      || isGoalEcho(title)
    ) {
      // 故意不用 goal 截断兜底：否则浮动条/任务卡会继续显示用户原话。
      title = '未命名任务';
    }
    return title;
  }

  function createPlan(draft = {}, { changeKind = 'persist' } = {}) {
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
    if (requestedParentPlanId && requestedParentPlanId === planId) {
      throw new Error('parentPlanId cannot be its own parent');
    }
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
      targetRepoId: normalizeOptionalName(draft.targetRepoId) ?? normalizeOptionalName(draft.deliveryBinding?.repoId),
      targetBranch: normalizeOptionalName(draft.targetBranch) ?? normalizeOptionalName(draft.deliveryBinding?.targetBranch),
      baseCommit: normalizeOptionalName(draft.baseCommit) ?? normalizeOptionalName(draft.deliveryBinding?.baseCommit),
      targetBranchSource: normalizeTargetBranchSource(draft.targetBranchSource)
        ?? normalizeTargetBranchSource(draft.deliveryBinding?.targetBranchSource),
      deliveryBinding: normalizeDeliveryBinding(draft.deliveryBinding, {
        targetWorkspacePath: draft.targetWorkspacePath,
        baseCommit: draft.baseCommit,
      }),
      parentPlanId: parentPlan?.planId,
      sourceTaskId: sourceTask?.taskId,
      rootPlanId: parentPlan ? (parentPlan.rootPlanId || parentPlan.planId) : undefined,
      relationType: parentPlan ? 'derived' : undefined,
      depth: parentPlan ? (Number.isInteger(parentPlan.depth) ? parentPlan.depth + 1 : 1) : undefined,
      title: sanitizePlanTitle(draft.title, draft.goal),
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
      delegationOrigin: normalizeDelegationOrigin(draft.delegationOrigin) || undefined,
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
    }), { changeKind });
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
    const created = createPlan({
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
    }, { changeKind: 'goal-accepted' });
    armUiDeliveryVerification(created, { phase: 'goal-created' });
    return created;
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
    const upgradeRunner = runnerPatchForAcceptedGoalUpgrade(plan.runner);
    const revised = revisePlan(planId, {
      ...patch,
      ...(!plan.targetWorkspacePath && plan.originWorkspacePath
        ? { targetWorkspacePath: plan.originWorkspacePath }
        : {}),
      ...(upgradeRunner ? { runner: upgradeRunner } : {}),
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
    armUiDeliveryVerification(revised, { phase: 'intake-promoted' });
    return revised;
  }

  function upsertGoalContract(conversationId, draft = {}) {
    const normalizedConversationId = normalizeConversationId(conversationId);
    const {
      revisionReason,
      changedBy,
      createdBy,
      ...planPatch
    } = draft;
    const conversationPlans = normalizedConversationId
      ? listPlanDetailsByConversation(normalizedConversationId)
      : [];
    let activeGoal = conversationPlans
      .filter((plan) => isActivePlan(plan) && isSelfDrivenGoal(plan))
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0]
      || null;
    if (!activeGoal) {
      return createGoalContract({ ...draft, conversationId: normalizedConversationId ?? draft.conversationId });
    }

    // intake 契约初始 status=executing；goal_create_plan 升级时若调用方显式
    // 传入 accepted，应采用该值，不能被旧的 executing 覆盖。否则 main 侧
    // auto-start 仅看 status===accepted 时会漏启动 Runner。
    const requestedStatus = typeof planPatch.status === 'string' ? planPatch.status : null;
    const safeStatus = requestedStatus
      || (activeGoal.status === 'accepted' || activeGoal.status === 'executing' || activeGoal.status === 'paused'
        ? activeGoal.status
        : 'accepted');
    const tasks = Array.isArray(planPatch.tasks) && planPatch.tasks.length > 0 ? planPatch.tasks : activeGoal.tasks;
    // intake → accepted_goal 原地升级时，确保 activation 与 resolution 与 promote 一致。
    const upgradingFromIntake = activeGoal.activation?.kind === 'intake'
      && (planPatch.activation?.kind === 'accepted_goal' || requestedStatus === 'accepted');
    const shouldEmitGoalAccepted = upgradingFromIntake;
    // 升级为 accepted_goal 时必须清掉 intake 残留：
    // 1) 未消费 interruption，否则 persist 会把计划派生回 failed / interrupted；
    // 2) 流错误收敛盖上的 waiting_user，否则 auto-start 闸门会当成真提问拦下 Runner。
    const upgradeRunner = shouldEmitGoalAccepted
      ? runnerPatchForAcceptedGoalUpgrade(activeGoal.runner)
      : undefined;
    const revised = revisePlan(activeGoal.planId, {
      ...planPatch,
      conversationId: normalizedConversationId ?? activeGoal.conversationId,
      tasks,
      status: safeStatus,
      workflowKind: 'goal_self_driven',
      ...(upgradeRunner ? { runner: upgradeRunner } : {}),
      activation: {
        ...(activeGoal.activation || {}),
        ...(planPatch.activation || {}),
        kind: 'accepted_goal',
        acceptedAt: activeGoal.activation?.acceptedAt || planPatch.activation?.acceptedAt || new Date().toISOString(),
        acceptedBy: upgradingFromIntake
          ? (planPatch.activation?.acceptedBy || 'agent:goal_create_plan')
          : (planPatch.activation?.acceptedBy || activeGoal.activation?.acceptedBy),
      },
      intake: upgradingFromIntake
        ? {
          ...(activeGoal.intake || {}),
          ...(planPatch.intake || {}),
          resolution: 'goal_confirmed',
        }
        : (planPatch.intake || activeGoal.intake),
      executionPolicy: {
        ...(activeGoal.executionPolicy || DEFAULT_SELF_DRIVEN_POLICY),
        ...(planPatch.executionPolicy || {}),
        autonomy: 'self_driven',
      },
    }, {
      reason: revisionReason || (upgradingFromIntake ? 'intake:goal_confirmed' : '更新了目标内容'),
      changedBy: changedBy || createdBy || 'agent',
      changeKind: shouldEmitGoalAccepted ? 'goal-accepted' : 'persist',
    });
    armUiDeliveryVerification(revised, { phase: upgradingFromIntake ? 'intake-promoted' : 'contract-revised' });
    return revised;
  }

  /**
   * 修订计划内容（先规划阶段的反复修改 / revise）。
   * 递增 version，并向 revisionHistory 追加一条。progress 自动重算。
   * 不允许通过本方法直接改 progress（会被忽略并重算）。
   */
  function revisePlan(planId, patch = {}, { reason, changedBy, changeKind = 'persist' } = {}) {
    const plan = getPlan(planId);
    if (!plan) return null;
    const { progress: _ignore, version: _v, revisionHistory: _rh, modelReviews: _reviews, modelReviewSourceRevision: _reviewSource, ...safePatch } = patch;
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
    if ('title' in safePatch) {
      const nextTitle = sanitizePlanTitle(safePatch.title, safePatch.goal ?? plan.goal);
      const previousTitle = typeof plan.title === 'string' ? plan.title.trim() : '';
      // 分析意图后允许刷新为更好的短标题；但空/占位/坏标题不要把已有好标题冲掉。
      if (
        nextTitle === '未命名任务'
        && previousTitle
        && previousTitle !== '未命名任务'
      ) {
        delete safePatch.title;
      } else {
        safePatch.title = nextTitle;
      }
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
    if (isAcceptanceClosePatch(plan.resultAcceptance, next.resultAcceptance)) {
      const knownRefs = new Set(collectHeldEvidenceRefs(plan));
      for (const record of readEvidenceIndex()) {
        if (evidenceRecordMatchesPlan(record, plan) && record.evidenceRef) {
          knownRefs.add(record.evidenceRef);
        }
      }
      assertAcceptanceCloseGate({ ...next, modelReviewSourceRevision: criterionSourceRevision(next) }, { knownRefs: [...knownRefs] });
    }
    return persist(withRunTraceEvent(next, {
      type: 'plan_revised',
      summary: reason ? `计划有调整：${reason}` : '计划有调整',
      payload: {
        summaryCode: 'plan_revised',
        reason: reason || null,
        changedBy: changedBy || null,
        version: nextVersion,
      },
    }), { changeKind });
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
      waitingOnUser: undefined,
      lastError: undefined,
      // 中断标记是「待用户确认的中断事实」，resume（继续执行）不应把它清掉，
      // 否则中断→继续链路会被 decideIntakeConvergence 误判为 pure_qa 并静默删除
      // （审计：mark_interrupted keep 后同一契约仍被 pure_qa→remove）。
      // 只有当调用方显式传入 consumedInterruption:true（用户明确放弃/接管）时才清除。
      ...(patch.consumedInterruption === true ? { interruption: undefined } : {}),
      updatedAt: patch.updatedAt || now,
    }, planId);
    return persist(
      { ...plan, status: 'executing', runner: nextRunner, updatedAt: now },
      { preserveStatus: true },
    );
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
    // 高频 overlay 与完整持久化共享同一最终状态校正；即使状态字符串未变化，
    // 也会修复 active runner 缺 segment / paused runner 仍开 segment 的历史脏状态。
    const timing = reconcileGoalTimingWithRunner(
      plan.timing,
      plan.status,
      nextRunner?.status,
      now,
    );
    const nextPlan = { ...plan, runner: nextRunner, updatedAt: now, ...(timing ? { timing } : {}) };

    // 高频 runner 进度：内存即时可见 + 广播 runner-progress（带 runner 本地 patch），
    // 写盘节流到 1s，避免 CLI 后台跑时跨进程刷新把 Desktop 打卡。
    if (changeKind === 'runner-progress') {
      const normalized = normalizePlan(nextPlan);
      const next = guardUiCompletion({
        ...normalized,
        status: (hasActiveGoalRepair(normalized) && derivePlanStatus(normalized.status, normalized.tasks) === TERMINAL_OK)
          ? 'executing'
          : derivePlanStatus(normalized.status, normalized.tasks),
        progress: aggregateProgress(normalized.tasks),
        ...(normalized.timing ? { timing: normalized.timing } : {}),
      });
      runnerProgressOverlay.set(planId, next);
      if (!runnerProgressVersions.has(planId)) runnerProgressVersions.set(planId, fileVersion(planFile(planId)));
      scheduleRunnerProgressPersist(planId);
      // soft progress：IPC 合并；硬状态跃迁仍走下面即时 persist 路径。
      scheduleRunnerProgressNotify(next.planId, next.conversationId ?? null);
      return next;
    }

    // 状态跃迁/终态等：立即 flush + 完整 persist（会清 overlay）。
    // 已在上面按 runner 调整 timing 时，把 prev 标成与 next 相同，避免 persist 因 plan 仍为
    // executing 而再次 open/close segment。
    return persist(nextPlan, {
      changeKind: 'runner-state',
      runner: nextRunner,
      prevStatus: plan.status,
      prevTiming: timing ?? plan.timing,
      preserveStatus: ['cancelled', 'paused'].includes(plan.status),
    });
  }

  /**
   * Persist request_user_input as the final action-owner transition of a turn.
   *
   * A model may complete the current leaf task and then ask the user to choose
   * the next direction in the same turn. In that sequence the question is the
   * final fact: reopen a just-completed plan and persist waiting_user so Task
   * Overview does not misclassify the turn as a result awaiting acceptance.
   *
   * Also used when the user clicks「继续讨论 / 继续追问」on a result_ready card:
   * that means acceptance failed and the same GoalPlan must leave the acceptance
   * queue (same card continues), instead of staying result_ready while a new
   * plan stacks on top.
   */
  function markRequestedUserInput(planId, runnerPatch = {}) {
    const plan = getPlan(planId);
    if (!plan || ['failed', 'cancelled'].includes(plan.status)) return null;

    const now = new Date().toISOString();
    const currentRunner = normalizeRunnerState(plan.runner, planId) || {
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
    // 调用方用 blockerAudit.reason 传递「为什么在等」；旧式调用可能直接给 blockedReason。
    // 只有两者都没有时才回落到泛化的「请求用户输入」。
    const patchReason = typeof runnerPatch?.blockedReason === 'string' && runnerPatch.blockedReason.trim()
      ? runnerPatch.blockedReason.trim()
      : (typeof runnerPatch?.blockerAudit?.reason === 'string' && runnerPatch.blockerAudit.reason.trim()
        ? runnerPatch.blockerAudit.reason.trim()
        : null);
    const explicitBlockReason = patchReason ?? 'requested_user_input';
    const nextRunner = normalizeRunnerState({
      ...currentRunner,
      ...runnerPatch,
      enabled: true,
      status: 'waiting_user',
      intent: 'block',
      phase: 'waiting_user',
      // 保留调用方给出的具体原因（例如宽限后请求澄清）；缺省才是泛化的「请求用户输入」。
      // 写死泛化原因会让「在等真人」与「为什么在等」两件事互相覆盖。
      blockedReason: explicitBlockReason,
      waitingOnUser: true,
      lastError: undefined,
      updatedAt: now,
    }, planId);
    const timing = applyGoalTimingTransition(
      plan.timing,
      plan.status,
      'executing',
      currentRunner.status,
      nextRunner?.status,
      now,
    );

    const nextPlan = {
      ...plan,
      status: 'executing',
      runner: nextRunner,
      updatedAt: now,
      ...(timing ? { timing } : {}),
    };
    // 从待验收续接时清掉验收戳，避免同卡再被投影成已验收终态。
    if (plan.status === 'completed') {
      delete nextPlan.resultAcceptance;
    }
    return persist(nextPlan, {
      preserveStatus: true,
      changeKind: 'runner-state',
      runner: nextRunner,
      prevStatus: plan.status,
      prevTiming: plan.timing,
    });
  }

  /**
   * Consume a user reply to request_user_input as one persisted transition.
   * The Runner state and decision event must not diverge because Task Overview
   * projects its action owner directly from the persisted Runner.
   */
  function consumeRequestedUserInput(planId, event = {}) {
    const plan = getPlan(planId);
    if (!canConsumeRequestedUserInput(plan)) return null;

    const now = new Date().toISOString();
    const currentTrace = normalizeRunTrace(plan.runTrace, { goalPlanId: planId });
    const normalizedEvent = normalizeRunEvent({
      ...event,
      goalPlanId: planId,
      createdAt: event.createdAt || now,
    }, { goalPlanId: planId });
    if (!normalizedEvent) {
      throw new Error(`[goal-plan-store] invalid requested user input event for plan ${planId}`);
    }

    const currentRunner = normalizeRunnerState(plan.runner, planId) || {};
    const nextRunner = normalizeRunnerState({
      ...currentRunner,
      enabled: true,
      status: 'running',
      intent: 'execute',
      // 用户接话即接管等待：消费残留中断，避免 keep-live 判定
      // （prevStatus === 'interrupted' 且中断未消费）把已收尾的计划拉回 executing。
      interruption: null,
      phase: ['waiting_user', 'blocked'].includes(currentRunner.phase) ? 'orient' : (currentRunner.phase || 'orient'),
      blockerAudit: null,
      blockedReason: undefined,
      waitingOnUser: undefined,
      lastError: undefined,
      updatedAt: now,
    }, planId);
    const timing = applyGoalTimingTransition(
      plan.timing,
      plan.status,
      plan.status,
      currentRunner.status,
      nextRunner?.status,
      now,
    );
    const nextTrace = {
      ...currentTrace,
      events: [...currentTrace.events, normalizedEvent],
    };
    const activeNodeId = normalizeOptionalString(event.activeNodeId) || normalizedEvent.nodeId;
    if (activeNodeId) nextTrace.activeNodeId = activeNodeId;

    // 注意：这里不代答 waiting_user 叶子。等待叶子（验收/确认动作）必须由
    // runner 续跑后的轮次带着用户答复去完成并落 Evidence；
    // 消费只负责解除 runner 停等与消费残留中断。

    // interrupted 残留态随消费一起解除：runner 已回到 running，计划应恢复
    // 可运行态，否则主进程消费分支的 shouldResumeGoalRunnerAfterUserDecision
    // （要求 accepted/executing）不会把执行权交还 runner，计划永远停在 interrupted。
    const nextStatus = plan.status === 'interrupted' ? 'executing' : plan.status;

    return persist({
      ...plan,
      status: nextStatus,
      runner: nextRunner,
      runTrace: nextTrace,
      updatedAt: now,
      ...(timing ? { timing } : {}),
    }, {
      changeKind: 'runner-state',
      runner: nextRunner,
      prevStatus: plan.status,
      prevTiming: timing ?? plan.timing,
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
    // Late reports remain evidence, but cannot reactivate a suspended/terminal runner.
    const preserveLifecycle = current.enabled === false
      || ['paused', 'interrupted', 'blocked', 'failed', 'completed', 'cancelled', 'waiting_user'].includes(current.status)
      || ['paused', 'interrupted', 'blocked', 'failed', 'completed', 'cancelled', 'waiting_user'].includes(plan.status);
    const nextRunner = normalizeRunnerState({
      ...current,
      status: preserveLifecycle ? current.status : stillRunning ? 'exploring' : 'idle',
      intent: preserveLifecycle ? current.intent : stillRunning ? 'explore' : 'verify',
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
      TERMINAL_CANCEL,
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
      const nextStatus = status ?? t.status;
      const updated = {
        ...t,
        status: nextStatus,
        evidenceRefs: nextRefs,
      };
      if (change.result !== undefined) updated.result = change.result;
      if (change.failureReason !== undefined) updated.failureReason = change.failureReason;
      if (change.blockedReason !== undefined) updated.blockedReason = change.blockedReason;
      // 残留原因字段治理：状态翻转后，与新状态矛盾的旧原因不应跨过状态变更存活。
      // - 转入 completed 时清除旧 failureReason（失败后重试成功的翻转，即
      //   “已完成却还展示失败原因”缺陷的真值修复）；failed→running 的重试
      //   保留 failureReason 作为失败审计（见既有契约测试『保留失败 Evidence』）。
      // - 离开 waiting_user 时清除旧 blockedReason（阻塞解除后旧原因不再适用）。
      // 显式传入的 change.failureReason / change.blockedReason 优先（上面已先写入），
      // 此处仅清除调用方未显式声明的残留值。cancelOpenTasks 用 blockedReason 记录
      // 取消原因（cancelled 态）不经此路径，不受影响。
      if (nextStatus === TERMINAL_OK && updated.failureReason !== undefined
        && change.failureReason === undefined) {
        delete updated.failureReason;
      }
      if (nextStatus !== BLOCKED && updated.blockedReason !== undefined
        && change.blockedReason === undefined) {
        delete updated.blockedReason;
      }
      if (status === 'running' && !t.startedAt) updated.startedAt = now;
      if (status === TERMINAL_OK || status === TERMINAL_FAIL || status === TERMINAL_CANCEL) {
        updated.completedAt = now;
      }
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
      const childComplete = childTasks.length > 0
        && childTasks.every((task) => LEAF_TERMINAL_STATUSES.has(task.status))
        && !childFailed;
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
        const linked = updateTaskInTree(parent.tasks, updatedPlan.sourceTaskId, (task) => {
          const linkedTask = {
            ...task,
            status: delegatedStatus,
            executionMode: 'delegated',
            childPlanIds: [...new Set([...(task.childPlanIds || []), updatedPlan.planId])],
          };
          if (childFailed) {
            linkedTask.blockedReason = `派生子目标 ${updatedPlan.title} 未成功完成`;
          } else if (linkedTask.blockedReason !== undefined) {
            // 子目标不再失败时，清除上一轮派生链接写入的残留 blockedReason，
            // 避免父任务状态已翻转（running/waiting_user）仍展示旧阻塞原因。
            delete linkedTask.blockedReason;
          }
          return linkedTask;
        });
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
   * 用户改向/撤回剩余工作时，把未终态叶子标成 cancelled。
   * persist 会按叶子事实把计划收尾为 completed（含 cancelled 叶子），泵即可停。
   */
  function cancelOpenTasks(planId, { reason } = {}) {
    const plan = getPlan(planId);
    if (!plan) return null;
    const now = new Date().toISOString();
    const note = typeof reason === 'string' && reason.trim()
      ? reason.trim()
      : '用户撤回剩余工作';
    let cancelledCount = 0;
    const walk = (list) => (list || []).map((task) => {
      const children = Array.isArray(task.subtasks) ? task.subtasks : [];
      if (children.length > 0) return { ...task, subtasks: walk(children) };
      if (LEAF_TERMINAL_STATUSES.has(task.status)) return task;
      cancelledCount += 1;
      return {
        ...task,
        status: TERMINAL_CANCEL,
        blockedReason: note,
        completedAt: now,
      };
    });
    const tasks = walk(plan.tasks);
    if (cancelledCount === 0) return plan;
    return persist({ ...plan, tasks, updatedAt: now });
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
      if (criterion.kind === 'model_review') throw new Error('model_review_requires_host_verifier');
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

  function recordModelReviews(planId, { sourceRevision, verifierRunId, passed, evidenceRefs = [] } = {}) {
    const plan = getPlan(planId);
    if (!plan) return null;
    if (!sourceRevision || sourceRevision !== criterionSourceRevision(plan)) throw new Error('model_review_source_changed');
    const run = plan.runner?.verifierRuns?.find(row => row.verifierRunId === verifierRunId);
    if (!run || !['passed', 'failed'].includes(run.status) || (passed === true && run.status !== 'passed')) {
      throw new Error('model_review_requires_host_verifier');
    }
    if (passed === true && !evidenceRefs.length) throw new Error('model_review_missing_evidence');
    for (const ref of evidenceRefs) assertEvidenceRefIndexed(plan, ref, 'model review');
    const rows = (plan.successCriteria || []).filter(item => item.kind === 'model_review').map(item => ({
      criterionId: item.id, sourceRevision, verifierRunId, passed: passed === true,
      evidenceRefs, checkedAt: new Date().toISOString(),
    }));
    return persist({ ...plan, modelReviews: [...(plan.modelReviews || []), ...rows].slice(-64) });
  }

  function recordQualityReview(planId, review = {}) {
    const plan = getPlan(planId);
    if (!plan) return null;
    const qualityReview = normalizeQualityReview(review);
    if (!qualityReview) return plan;
    const now = new Date().toISOString();
    const next = {
      ...plan,
      qualityReview,
      updatedAt: now,
    };
    // 质检已通过时，过期的 quality_review_pending 不再代表真实阻断。
    if (
      qualityReview.status === 'passed'
      && plan.deliveryHandoff?.status === 'stopped'
      && plan.deliveryHandoff?.stoppedReason === 'quality_review_pending'
    ) {
      const { stoppedReason: _stalePending, ...restHandoff } = plan.deliveryHandoff;
      next.deliveryHandoff = {
        ...restHandoff,
        status: 'idle',
        updatedAt: now,
      };
    }
    return persist(next);
  }

  function recordDeliveryHandoff(planId, handoff = {}) {
    const plan = getPlan(planId);
    if (!plan) return null;
    const deliveryHandoff = normalizeDeliveryHandoff({
      ...handoff,
      updatedAt: handoff.updatedAt || new Date().toISOString(),
    });
    if (!deliveryHandoff) return plan;
    return persist({
      ...plan,
      deliveryHandoff,
      updatedAt: deliveryHandoff.updatedAt,
    });
  }

  function recordDeliveryIsolation(planId, isolation = {}) {
    const plan = getPlan(planId);
    if (!plan) return null;
    const nextBinding = normalizeDeliveryBinding({
      ...(plan.deliveryBinding && typeof plan.deliveryBinding === 'object' ? plan.deliveryBinding : {}),
      repoId: isolation.repoId ?? plan.deliveryBinding?.repoId ?? plan.targetRepoId,
      targetBranch: isolation.targetBranch ?? plan.deliveryBinding?.targetBranch ?? plan.targetBranch,
      targetBranchSource: isolation.targetBranchSource
        ?? plan.deliveryBinding?.targetBranchSource
        ?? plan.targetBranchSource,
      targetWorkspacePath: isolation.targetWorkspacePath
        ?? plan.deliveryBinding?.targetWorkspacePath
        ?? plan.targetWorkspacePath,
      baseCommit: isolation.baseCommit ?? plan.deliveryBinding?.baseCommit ?? plan.baseCommit,
      executionIsolation: isolation.executionIsolation ?? 'worktree',
      taskBranch: isolation.taskBranch,
      worktreePath: isolation.worktreePath,
      boundAt: plan.deliveryBinding?.boundAt,
    }, {
      targetWorkspacePath: plan.targetWorkspacePath,
      baseCommit: plan.baseCommit,
    });
    if (!nextBinding) return plan;
    return persist({
      ...plan,
      deliveryBinding: nextBinding,
      updatedAt: new Date().toISOString(),
    });
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
    writeIndex( index);
    try {
      if (existsSync(planFile(planId))) unlinkSync(planFile(planId));
    } catch {}
    publishPersistedChange('delete', planId, {
      conversationId,
      changeKind: 'delete',
    });
    return listPlans();
  }

  /**
   * intake 收敛审计（追加式 JSONL，见 peer-knowledge intake-convergence 文档）。
   *
   * 每行一条结构化事件，用于定量回答「并发/中断漏了多少任务」：
   * - action=delete_plan：intake 契约被收敛器判为纯问答而静默删除（每次 deletePlan 前）。
   * - action=mark_interrupted：intake 契约首答被打断，升级为「待用户确认」打标。
   *
   * 写入失败只告警，绝不阻塞主流程（与 writeGoalChangeEvent 同策略）。
   *
   * @param {object} entry { action, decision, reason, conversationId, planId, terminalStatus }
   */
  function appendIntakeConvergenceAudit(entry = {}) {
    try {
      appendJsonl(path.join(storeDir, 'intake-convergence.jsonl'), {
        event: 'intake_convergence',
        ...entry,
        createdAt: new Date().toISOString(),
        writerPid: process.pid,
      });
    } catch (error) {
      console.warn('[goal-plan-store] intake convergence audit failed:', error?.message || error);
    }
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
    writeIndex( remaining);
    for (const meta of removed) {
      try {
        if (existsSync(planFile(meta.planId))) unlinkSync(planFile(meta.planId));
      } catch {}
    }
    // 批量删除只广播一次，避免抖动；planId 传 null 表示非单一计划变更。
    for (const meta of removed) clearRunnerProgressState(meta.planId);
    publishPersistedChange('delete', null, {
      conversationId: normalizedConversationId,
      changeKind: 'delete',
    });
    return listPlans();
  }

  return {
    getStoreDir: () => storeDir,
    listPlans,
    listPlanMetadata,
    listPlansByConversation,
    countAwaitingApprovalsByConversation,
    listPlanDetails,
    listPlanDetailsByWorkspace,
    listPlanDetailsByConversation,
    getActivePlanByConversation,
    getUnacceptedCompletedPlanByConversation,
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
    markRequestedUserInput,
    consumeRequestedUserInput,
    setRunnerState,
    prepareContextCheckpoint,
    commitContextCheckpoint,
    markContextCompactionPersisted,
    markContextCheckpointConsumed,
    supersedeContextCheckpoint,
    appendRunEvent,
    dispatchExplorer,
    reportExplorer,
    recordVerifierRun,
    recordEvidenceRefs,
    listEvidenceIndex: readEvidenceIndex,
    hasDesktopPreviewEvidence,
    isUiDeliveryRequired,
    findEvidenceIndexRecords,
    recordTaskEvidence,
    cancelOpenTasks,
    recordCriterionResults,
    recordModelReviews,
    recordQualityReview,
    recordDeliveryHandoff,
    recordDeliveryIsolation,
    recordManualConfirmation,
    deletePlan,
    deletePlanByConversation,
    appendIntakeConvergenceAudit,
    setOnChange,
    subscribeChanges,
  };
}

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
 * 负责两种「只前进」的派生（均与 aggregateProgress 同源、由叶子事实驱动、纯函数、不回退）：
 *
 * 1. 开工推进：当计划已处于「已批准」状态（approved），
 *    但已有任意子任务进入活跃或终态（running / completed / failed / waiting_user）时，
 *    说明执行已经开始，此时把计划推进到 'executing'，从而让审批相关 UI 正确收敛。
 *    注意：'awaiting_approval'（未批准）不在此规则的推进范围内——未批准计划即便
 *    出现活跃叶子，也不会被派生成 'executing'，以杜绝「顶层 executing 但从未批准、
 *    Runner 未启动」的僵死态（详见规则 1 实现处的说明）。批准闸门只能由显式
 *    recordApproval 打开。
 *
 * 2. 自动收尾（见 Goal 计划自动收尾设计）：当计划已 'executing'
 *    且存在叶子、且所有叶子均为终态（completed / failed）时，把顶层推进到终态——
 *    含任一 failed → 'failed'，否则全 completed → 'completed'。这修复了「子任务 100%
 *    完成但顶层仍显示 executing」的现象。waiting_user（阻塞）叶子不算终态，存在它时不收尾；
 *    空计划（无叶子）不收尾。
 *
 * 不做任何回退（已是 completed/failed/cancelled/paused 等终态/显式态不会被改回），
 * 避免与 recordApproval / setPlanStatus 的显式状态机产生竞争。
 *
 * @param {string} currentStatus 当前 plan.status
 * @param {Array} tasks 顶层子任务树
 * @returns {string} 派生后的 plan.status
 */
export function derivePlanStatus(currentStatus, tasks) {
  // 规则 2：executing + 全叶子终态 → 自动收尾（completed/failed）。
  if (currentStatus === 'executing') {
    let leafTotal = 0;
    let allTerminal = true;
    let hasFailed = false;
    const walkLeaves = (list) => {
      for (const t of list || []) {
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
    walkLeaves(tasks);
    if (leafTotal > 0 && allTerminal) {
      return hasFailed ? TERMINAL_FAIL : TERMINAL_OK;
    }
    return currentStatus;
  }

  // 规则 1：执行前 → executing（一旦有叶子开工）。
  // 注意：PRE_EXECUTION 只含 'approved'，不含 'awaiting_approval'。
  // 未批准的计划即便出现了 running/终态叶子，也不允许被派生成 'executing'——
  // 否则会产生「顶层 executing 但从未批准、Runner 未启动」的僵死态
  // （审批按钮消失、探查也永远派发不出去）。批准闸门必须由显式 recordApproval
  // 把 status 推进到 'approved' 后，本规则才接手推进到 'executing'。
  const PRE_EXECUTION = new Set(['approved']);
  if (!PRE_EXECUTION.has(currentStatus)) return currentStatus;

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

function normalizeStringArray(value) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim())
    : [];
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
      : 'Explore missing evidence for the active goal',
    reason: typeof request?.reason === 'string' && request.reason.trim()
      ? request.reason.trim()
      : 'Goal Runner requested read-only exploration',
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
  if (typeof run.failureReason === 'string' && run.failureReason.trim()) {
    normalized.failureReason = run.failureReason.trim();
  }
  const batchId = typeof run.batchId === 'string' && run.batchId.trim()
    ? run.batchId.trim()
    : (typeof fallback.batchId === 'string' && fallback.batchId.trim() ? fallback.batchId.trim() : undefined);
  if (batchId) normalized.batchId = batchId;
  return normalized;
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

const ACTIVE_PLAN_STATUSES = new Set(['drafting', 'awaiting_approval', 'approved', 'executing', 'paused']);

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
  if (typeof runner.currentTaskId === 'string' && runner.currentTaskId.trim()) {
    next.currentTaskId = runner.currentTaskId.trim();
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
  const normalized = {
    ...plan,
    conversationId: normalizedConversationId ?? undefined,
    targetWorkspacePath: normalizeWorkspacePath(plan.targetWorkspacePath) ?? undefined,
    status: normalizedStatus,
  };
  const runner = normalizeRunnerState(plan.runner, plan.planId);
  return runner ? { ...normalized, runner } : normalized;
}

function isActivePlan(plan) {
  return ACTIVE_PLAN_STATUSES.has(plan?.status);
}

function isInactivePlan(plan) {
  return plan?.status === 'cancelled';
}

export function createGoalPlanStore({ storeDir = pathOf('goalPlans'), onChange } = {}) {
  const indexFile = path.join(storeDir, 'index.jsonl');

  // 变更通知 Seam：任何写操作（create/revise/approve/setStatus/recordTaskEvidence/delete）
  // 完成后触发 onChange，使 main 进程可向 renderer 广播 'goalPlans:changed'。
  // 收口于此，AI 工具路径（local-goal-provider）与 IPC 路径共享同一通知，
  // 无需在每个调用点重复挂广播。回调异常被吞掉，绝不影响写盘结果。
  function notifyChanged(reason, planId) {
    if (typeof onChange !== 'function') return;
    try {
      onChange({ reason, planId: planId ?? null });
    } catch (err) {
      // 广播失败不影响写盘结果，但显式打印以便排查（不要静默吞）。
      console.warn('[goal-plan-store] onChange broadcast failed:', err);
    }
  }

  function planFile(id) {
    return path.join(storeDir, `${id}.json`);
  }

  function readIndex() {
    return readJsonl(indexFile);
  }

  function toMeta(plan) {
    return {
      planId: plan.planId,
      title: plan.title,
      status: plan.status,
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

  function persist(plan) {
    // progress 始终由子任务聚合派生，写入前强制重算覆盖（不可手填）。
    const normalized = normalizePlan(plan);
    const next = {
      ...normalized,
      // 计划整体状态与 progress 同源：仅「执行前 → executing」的只前进派生，
      // 让对话直接触发执行的场景也能正确收起面板审批按钮。
      status: derivePlanStatus(normalized.status, normalized.tasks),
      progress: aggregateProgress(normalized.tasks),
    };
    writeJsonAtomic(planFile(next.planId), next);
    syncIndex(next);
    notifyChanged('persist', next.planId);
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
    const plan = {
      planId: draft.planId || randomUUID(),
      conversationId: normalizeConversationId(draft.conversationId) ?? undefined,
      threadId: draft.threadId,
      agentId: draft.agentId,
      targetWorkspacePath: normalizeWorkspacePath(draft.targetWorkspacePath) ?? undefined,
      title: draft.title || '',
      goal: draft.goal || '',
      successCriteria: draft.successCriteria || [],
      boundaries: draft.boundaries || { inScope: [], outOfScope: [] },
      exceptionPolicies: draft.exceptionPolicies || [],
      involvedFiles: draft.involvedFiles || [],
      tasks,
      status: draft.status || 'drafting',
      approval: draft.approval,
      progress: aggregateProgress(tasks),
      version: 1,
      revisionHistory: [],
      evidenceRefs: draft.evidenceRefs || [],
      promptContextEpochId: draft.promptContextEpochId,
      createdAt: now,
      updatedAt: now,
      createdBy: draft.createdBy,
    };
    // 单活跃计划：先收尾/作废同会话其它活跃态旧计划（排除自身），再落库新计划。
    supersedeAwaitingDrafts(plan.conversationId, plan.planId);
    return persist(plan);
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
    return persist(next);
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
    const next = {
      ...plan,
      approval: {
        decision,
        confirmationId: approval.confirmationId || randomUUID(),
        decidedBy: approval.decidedBy,
        decidedAt: approval.decidedAt || new Date().toISOString(),
        feedback: approval.feedback,
      },
      status,
      updatedAt: new Date().toISOString(),
    };
    return persist(next);
  }

  /** 推进计划整体状态（executing / paused / completed / cancelled / failed）。 */
  function setPlanStatus(planId, status) {
    const plan = getPlan(planId);
    if (!plan) return null;
    return persist({ ...plan, status, updatedAt: new Date().toISOString() });
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
    return persist({ ...plan, runner: nextRunner, updatedAt: now });
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

  /** 回填 Explorer 报告；完成态必须携带 evidenceRefs，且不允许借此改写任务状态。 */
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
    if (status === 'completed' && (!normalizedReport || normalizedReport.evidenceRefs.length === 0)) {
      throw new Error(
        `[goal-plan-store] explorer ${explorerId} cannot be 'completed' without evidenceRefs`,
      );
    }
    const nextRun = normalizeExplorerRun({
      ...explorers[index],
      status,
      report: normalizedReport,
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
      PRE_APPROVAL_PLAN.has(plan.status)
    ) {
      throw new Error(
        `[goal-plan-store] task ${taskId} cannot enter '${status}' before plan ${planId} is approved (plan status: '${plan.status}')`,
      );
    }
    const mergedRefs = (refs, add) => {
      const set = new Set([...(refs || []), ...(add || [])]);
      return [...set];
    };
    if (status === TERMINAL_OK) {
      const incoming = change.evidenceRefs || [];
      if (incoming.length === 0) {
        // 也允许任务已有历史 evidenceRefs 的情况，但 completed 必须有至少一条。
        const existing = (() => {
          let found = null;
          const walk = (list) => {
            for (const t of list || []) {
              if (t.taskId === taskId) found = t;
              else if (t.subtasks) walk(t.subtasks);
            }
          };
          walk(plan.tasks);
          return found?.evidenceRefs || [];
        })();
        if (existing.length === 0) {
          throw new Error(
            `[goal-plan-store] task ${taskId} cannot be 'completed' without evidenceRefs`,
          );
        }
      }
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
    if (!found) {
      throw new Error(`[goal-plan-store] task ${taskId} not found in plan ${planId}`);
    }
    return persist({ ...plan, tasks, updatedAt: now });
  }

  function deletePlan(planId) {
    const index = readIndex().filter((m) => m.planId !== planId);
    writeJsonl(indexFile, index);
    try {
      if (existsSync(planFile(planId))) unlinkSync(planFile(planId));
    } catch {}
    notifyChanged('delete', planId);
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
    notifyChanged('delete', null);
    return listPlans();
  }

  return {
    listPlans,
    listPlansByConversation,
    listPlanDetails,
    listPlanDetailsByConversation,
    getActivePlanByConversation,
    getPlan,
    createPlan,
    revisePlan,
    recordApproval,
    setPlanStatus,
    setRunnerState,
    dispatchExplorer,
    reportExplorer,
    recordTaskEvidence,
    deletePlan,
    deletePlanByConversation,
  };
}

/**
 * Goal Runner skeleton —— 主进程托管编排器。
 *
 * 边界：
 * - Runner 只编排 GoalPlan 生命周期与 chat runtime continuation。
 * - Runner 不直接调用 bash/file/MCP/Plugin 等本地能力。
 * - 工具执行、权限、Evidence 仍由注入的 chatRuntime 及既有能力链路负责。
 */

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

function shouldStopForPlan(plan) {
  return !plan || TERMINAL_PLAN_STATUSES.has(plan.status) || plan.status === 'paused';
}

function runnerIsStopped(runner) {
  return !runner?.enabled || STOPPED_RUNNER_STATUSES.has(runner.status);
}

/**
 * 是否已获授权启动 Runner。批准是 Goal Runner 的准入闸门，必须在入口强制，
 * 不能只靠调用方自觉（见 AGENTS.md：能力/权限边界不得仅由调用约定保证）。
 *
 * 放行条件（任一）：
 * - plan.approval.decision === 'approve'：协议层的权威批准事实（最符合「证据负责治理」）。
 * - status 已是 executing / paused：支持 Runner re-entry 与 resume，这些态只可能由既往批准启动而来。
 */
function isStartAuthorized(plan) {
  if (!plan) return false;
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
export function evaluateVerificationGate(plan) {
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
    if (!done || !hasEvidence) {
      unmet.push({
        taskId: task.taskId ?? null,
        status: task.status ?? null,
        reason: !done ? 'not_completed' : 'missing_evidence',
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
    for (const criterion of criteria) {
      if (!criterion || typeof criterion !== 'object') continue;
      const kind = typeof criterion.kind === 'string' ? criterion.kind : 'manual';
      const criterionId = typeof criterion.id === 'string' ? criterion.id : null;
      if (AUTO_VERIFIABLE_CRITERION_KINDS.has(kind)) {
        autoCount += 1;
        const result = criterionId ? resultById.get(criterionId) : null;
        const passed = result?.passed === true;
        const hasRef = typeof result?.evidenceRef === 'string' && result.evidenceRef.trim();
        if (!passed || !hasRef) {
          unmet.push({
            criterionId,
            kind,
            reason: !result
              ? 'criterion_unverified'
              : !passed
                ? 'criterion_failed'
                : 'criterion_missing_evidence',
          });
        }
      } else {
        // manual 标准：不硬拦，转 pre-finish 人工确认，记 warning。
        warnings.push({ criterionId, kind, reason: 'manual_confirmation_required' });
      }
    }
    // 全 manual（无任何可自动验证项）：弱 DoD 告警——完成不阻断，但提示补强可执行验证。
    if (autoCount === 0) {
      warnings.push({ reason: 'weak_dod_all_manual' });
    }
  }

  return { passed: unmet.length === 0, unmet, warnings };
}

export function createGoalRunner({
  goalPlanStore,
  chatRuntime,
  explorerRunner = null,
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
        const current = goalPlanStore.getPlan(planId);
        if (current && !TERMINAL_PLAN_STATUSES.has(current.status)) {
          goalPlanStore.setPlanStatus(planId, 'failed');
        }
        goalPlanStore.setRunnerState(planId, {
          enabled: true,
          status: 'failed',
          intent: 'block',
          lastError: message,
          updatedAt: now(),
        });
        emit('goalRunner:failed', { planId, error: message });
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
      blockedReason: undefined,
      lastError: undefined,
      updatedAt: now(),
    });
  }

  async function start(planId, options = {}) {
    const initialized = initializeRunner(planId, options);
    if (!initialized) return null;
    emit('goalRunner:started', { planId });
    const promise = schedulePump(planId);
    if (options.awaitIdle) await promise;
    return getState(planId);
  }

  async function resume(planId, options = {}) {
    const plan = goalPlanStore.getPlan(planId);
    if (!plan || TERMINAL_PLAN_STATUSES.has(plan.status)) return null;
    goalPlanStore.setPlanStatus(planId, 'executing');
    goalPlanStore.setRunnerState(planId, {
      enabled: true,
      status: 'running',
      intent: options.intent ?? plan.runner?.intent ?? 'execute',
      updatedAt: now(),
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

  async function pump(planId, session) {
    // no-progress 双信号基线，仅存活于本次 pump 闭包内：
    // resume 会重新拉起 pump，计数自然清零（既往不咎语义）。
    let lastSignal = null;
    let noProgressStreak = 0;
    // 防偏航:范围基线在本次 pump 首轮建立,后续轮次相对它检测 drift（任务/文件膨胀）。
    let scopeBaseline = null;
    let reanchorInterval = REANCHOR_MIN_INTERVAL;
    while (!session.cancelled) {
      const plan = goalPlanStore.getPlan(planId);
      if (!plan) return null;

      if (plan.status === 'completed' || hasCompletedProgress(plan)) {
        goalPlanStore.setRunnerState(planId, {
          enabled: false,
          status: 'completed',
          intent: 'synthesize',
          updatedAt: now(),
        });
        emit('goalRunner:completed', { planId });
        return getState(planId);
      }
      if (plan.status === 'failed') {
        goalPlanStore.setRunnerState(planId, {
          enabled: false,
          status: 'failed',
          intent: 'block',
          updatedAt: now(),
        });
        emit('goalRunner:failed', { planId });
        return getState(planId);
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
          updatedAt: now(),
        });
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
            updatedAt: now(),
          });
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

      goalPlanStore.setRunnerState(planId, {
        enabled: true,
        status: 'running',
        intent: runner.intent ?? 'execute',
        reanchor,
        updatedAt: now(),
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
        goalPlanStore.setPlanStatus(planId, 'failed');
        goalPlanStore.setRunnerState(planId, {
          enabled: true,
          status: 'failed',
          intent: 'block',
          lastError: message,
          updatedAt: now(),
        });
        emit('goalRunner:failed', { planId, error: message });
        return getState(planId);
      }

      const afterTurnPlan = goalPlanStore.getPlan(planId);
      if (!afterTurnPlan) return null;
      const afterTurnRunner = afterTurnPlan.runner ?? {};
      // turnCount 仅作预算/tick 计数（maxTurns 熔断依据），每 tick +1。
      // 展示用的「工具」计数（toolCallCount）已由 runGoalTurn 注入的实时 sink 在工具
      // 派发处拥有并累加，这里不再重复累加，避免双重计数。
      goalPlanStore.setRunnerState(planId, {
        turnCount: toPositiveInteger(afterTurnRunner.turnCount, 0, { allowZero: true }) + 1,
        updatedAt: now(),
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
        if (!explorerRunner || typeof explorerRunner.runExplorer !== 'function') {
          goalPlanStore.setRunnerState(planId, {
            enabled: true,
            status: 'blocked',
            intent: 'explore',
            blockedReason: 'Explorer requested but no explorer runner is available',
            updatedAt: now(),
          });
          emit('goalRunner:blocked', {
            planId,
            reason: 'Explorer requested but no explorer runner is available',
          });
          return getState(planId);
        }
        // 每 turn 并发池：先把本轮请求整批派发（共享同一 batchId，供 UI 精确统计
        // 「本轮已完成/本轮总数」），再用大小为 N 的并发池并行执行 runExplorer。
        // N = explorerConcurrency（默认 5、硬上限 8）；不再受「每计划累计上限」约束，
        // 计划总数由 maxTurns 天然兜底。
        const concurrency = Math.min(
          EXPLORER_CONCURRENCY_HARD_CAP,
          toPositiveInteger(latest?.runner?.explorerConcurrency, DEFAULT_EXPLORER_CONCURRENCY),
        );
        const batchId = `${planId}:t${turnNumber}`;
        const dispatched = [];
        for (const request of exploreRequests) {
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

        // 并发安全：JS 单线程，await 之间无抢占，故共享累加器 explorerToolCalls
        // 与游标 cursor 的自增均为原子操作，无需额外锁。
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
            // fail-soft：单个 Explorer 失败只记 failed 并广播，不中止本轮其它并发任务，
            // 也不 early return；失败信息留待下一轮由模型自行判断是否重试/换向。
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
        if (session.cancelled) return getState(planId);
        if (explorerToolCalls > 0) {
          const afterExplore = goalPlanStore.getPlan(planId);
          goalPlanStore.setRunnerState(planId, {
            toolCallCount:
              toPositiveInteger(afterExplore?.runner?.toolCallCount, 0, { allowZero: true }) + explorerToolCalls,
            updatedAt: now(),
          });
        }
        continue;
      }

      if (result?.continue === false) {
        goalPlanStore.setRunnerState(planId, {
          enabled: true,
          status: 'idle',
          intent: result.intent ?? latestRunner?.intent ?? 'execute',
          updatedAt: now(),
        });
        emit('goalRunner:tickCompleted', { planId, turnNumber, continue: false });
        return getState(planId);
      }

      if (result?.blocked) {
        goalPlanStore.setRunnerState(planId, {
          enabled: true,
          status: 'blocked',
          intent: 'block',
          blockedReason: result.blockedReason || 'Goal Runner blocked',
          updatedAt: now(),
        });
        emit('goalRunner:blocked', { planId, reason: result.blockedReason || 'Goal Runner blocked' });
        return getState(planId);
      }

      if (result?.failed) {
        const message = result.failureReason || 'Goal Runner failed';
        goalPlanStore.setPlanStatus(planId, 'failed');
        goalPlanStore.setRunnerState(planId, {
          enabled: true,
          status: 'failed',
          intent: 'block',
          lastError: message,
          updatedAt: now(),
        });
        emit('goalRunner:failed', { planId, error: message });
        return getState(planId);
      }

      // 完成前验证门(设计文档第八章):模型声明完成时,要求所有叶子任务均已完成且带 Evidence。
      // 这比旧的 hasCompletedProgress（仅需部分进展）更严,机器化落地「完成以证据为准」,
      // 阻断「无证据的口头完成」。任一叶子未达标即转 blocked/verify,附未达标清单。
      if (result?.completed) {
        const gate = evaluateVerificationGate(latest);
        if (!gate.passed) {
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
      }
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

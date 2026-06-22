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
const DEFAULT_MAX_EXPLORERS = 3;
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

      if (runner.turnCount >= runner.maxTurns || runner.toolCallCount >= runner.maxToolCalls) {
        goalPlanStore.setRunnerState(planId, {
          enabled: true,
          status: 'budget_exhausted',
          intent: 'block',
          blockedReason: 'Goal Runner budget exhausted',
          updatedAt: now(),
        });
        emit('goalRunner:budgetExhausted', { planId });
        return getState(planId);
      }

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
      goalPlanStore.setRunnerState(planId, {
        enabled: true,
        status: 'running',
        intent: runner.intent ?? 'execute',
        updatedAt: now(),
      });
      emit('goalRunner:tickStarted', { planId, turnNumber });

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
      goalPlanStore.setRunnerState(planId, {
        turnCount: toPositiveInteger(afterTurnRunner.turnCount, 0, { allowZero: true }) + 1,
        toolCallCount:
          toPositiveInteger(afterTurnRunner.toolCallCount, 0, { allowZero: true }) + countToolCalls(result),
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
        let explorerToolCalls = 0;
        for (const request of exploreRequests) {
          if (session.cancelled) return getState(planId);
          const withRequest = goalPlanStore.dispatchExplorer(planId, request);
          const explorer = withRequest?.runner?.explorers?.at(-1);
          if (!explorer) continue;
          emit('goalRunner:explorerStarted', {
            planId,
            explorerId: explorer.explorerId,
            question: explorer.request?.question,
          });
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
            return getState(planId);
          }
        }
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

      if (result?.completed && !hasCompletedProgress(latest)) {
        goalPlanStore.setRunnerState(planId, {
          enabled: true,
          status: 'blocked',
          intent: 'verify',
          blockedReason: 'Completion requested without sufficient task Evidence',
          updatedAt: now(),
        });
        emit('goalRunner:blocked', {
          planId,
          reason: 'Completion requested without sufficient task Evidence',
        });
        return getState(planId);
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

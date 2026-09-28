/**
 * 停滞与失败的纯判断。不读盘，不发事件，不执行工具。
 * 事件映射只消费这里的结论；代理规则决定重试、换法、停掉或问用户。
 */

export const STALL_WINDOW_MS = 10 * 60 * 1000;
export const SAME_CAUSE_RETRY_LIMIT = 3;

const WAITING_KINDS = new Set(['approval', 'question', 'plan_approval']);

export function assessStall(session, { now, windowMs = STALL_WINDOW_MS } = {}) {
  const quiet = { stalled: false, stallId: null, anchor: null, waiting: false };
  const sessionId = text(session?.sessionId);
  if (!sessionId || session?.status !== 'running') return quiet;
  const waiting = waitingOnUser(session);
  if (waiting) return { ...quiet, waiting: true };
  const anchor = progressAnchor(session);
  const at = resolveNow(now);
  const window = Number.isFinite(windowMs) && windowMs >= 0 ? windowMs : STALL_WINDOW_MS;
  if (!anchor || at == null || at - anchor.ms < window) {
    return { ...quiet, anchor: anchor?.token ?? null };
  }
  return {
    stalled: true,
    stallId: `stall:${sessionId}:${anchor.token}`,
    anchor: anchor.token,
    waiting: false,
  };
}

export function describeFailure(session) {
  const reason = text(session?.interruption?.reason)
    || text(session?.runner?.interruption?.reason)
    || text(session?.blockedReason);
  const lastError = text(session?.lastError) || text(session?.runner?.lastError);
  const parts = [];
  if (reason) parts.push(reason);
  if (lastError && lastError !== reason) parts.push(lastError);
  return {
    reason,
    lastError,
    summary: parts.join('；'),
    cause: normalizeCause(reason || lastError),
  };
}

/**
 * failureLog 只记这次之前的尝试。当前这次另计 1。
 * 没有手写日志时，用 GoalPlan runTrace 里的重试，否则用 recoverableInterruptionCount。
 * 同一任务（taskId，否则 planId，否则 sessionId）且同一原因达到 3 次时停止自动重试。
 */
export function assessSameCause(session, failure = describeFailure(session)) {
  const cause = normalizeCause(failure?.cause) || describeFailure(session).cause;
  const taskKey = taskKeyOf(session);
  if (!cause) {
    return { taskKey, cause: '', count: 0, askUser: false, stopAutoRetry: false };
  }
  let count = 1;
  for (const entry of priorAttempts(session)) {
    if (!sameTask(entry, taskKey)) continue;
    const entryCause = normalizeCause(entry?.cause) || describeFailure(entry).cause;
    if (entryCause === cause) count += 1;
  }
  const askUser = count >= SAME_CAUSE_RETRY_LIMIT;
  return { taskKey, cause, count, askUser, stopAutoRetry: askUser };
}

const PRIOR_EVENT_TYPES = new Set(['step_failed', 'network_interrupted']);

function priorAttempts(session) {
  if (Array.isArray(session?.failureLog)) return session.failureLog;
  const traced = attemptsFromRunTrace(session);
  if (traced.length > 0) return traced;
  return attemptsFromRunnerCount(session);
}

function attemptsFromRunTrace(session) {
  const events = session?.runTrace?.events;
  if (!Array.isArray(events)) return [];
  const attempts = [];
  for (const event of events) {
    if (!PRIOR_EVENT_TYPES.has(event?.type)) continue;
    const reason = text(event?.payload?.reason) || text(event?.payload?.message);
    if (!reason) continue;
    attempts.push({
      taskId: session?.taskId,
      planId: session?.planId,
      sessionId: session?.sessionId,
      cause: reason,
    });
  }
  return attempts;
}

function attemptsFromRunnerCount(session) {
  const count = session?.runner?.recoverableInterruptionCount;
  if (!Number.isFinite(count) || count < 1) return [];
  const cause = describeFailure(session).cause;
  if (!cause) return [];
  const prior = Math.trunc(count);
  const entry = {
    taskId: session?.taskId,
    planId: session?.planId,
    sessionId: session?.sessionId,
    cause,
  };
  return Array.from({ length: prior }, () => entry);
}

/**
 * 把一份委托计划收成事件映射能读的会话事实。
 * 最终失败在计划里经常是 interrupted，这里仍标成 interrupted，摘要才能带上。
 */
export function watchFactsFromPlan(plan) {
  const origin = plan?.delegationOrigin;
  const sessionId = text(origin?.sessionId);
  if (!sessionId) return null;
  const leaves = leafFacts(plan);
  const lastProgressAt = latestCompletion(leaves);
  const startedAt = text(plan?.createdAt) || text(origin?.createdAt);
  const needsUser = needsFromPlan(plan, sessionId);
  return {
    sessionId,
    workspaceId: text(origin?.workspaceId),
    ...(text(plan?.planId) ? { planId: text(plan.planId) } : {}),
    ...(text(plan?.runner?.currentTaskId) ? { taskId: text(plan.runner.currentTaskId) } : {}),
    version: text(plan?.updatedAt) || text(plan?.planId) || sessionId,
    status: watchStatus(plan, needsUser.length > 0),
    ...(startedAt ? { startedAt } : {}),
    ...(lastProgressAt ? { lastProgressAt } : {}),
    leaves,
    ...(needsUser.length ? { needsUser } : {}),
    runner: {
      ...(text(plan?.runner?.lastError) ? { lastError: text(plan.runner.lastError) } : {}),
      ...(plan?.runner?.interruption && typeof plan.runner.interruption === 'object'
        ? { interruption: plan.runner.interruption }
        : {}),
      ...(Number.isFinite(plan?.runner?.recoverableInterruptionCount)
        ? { recoverableInterruptionCount: plan.runner.recoverableInterruptionCount }
        : {}),
    },
    ...(plan?.runTrace && typeof plan.runTrace === 'object' ? { runTrace: plan.runTrace } : {}),
  };
}

export function delegationFactsForWorkspace(plans, workspaceId) {
  const sessions = [];
  for (const plan of Array.isArray(plans) ? plans : []) {
    if (text(plan?.delegationOrigin?.workspaceId) !== workspaceId) continue;
    const facts = watchFactsFromPlan(plan);
    if (facts) sessions.push(facts);
  }
  return { sessions };
}

function watchStatus(plan, waiting) {
  if (plan?.status === 'cancelled') return 'cancelled';
  if (plan?.status === 'failed') return 'failed';
  if (plan?.status === 'interrupted' && plan?.runner?.status === 'failed') return 'interrupted';
  if (waiting) return 'waiting_user';
  const phase = plan?.delegationOrigin?.phase;
  if (phase === 'running' && plan?.status !== 'completed') return 'running';
  if (plan?.status === 'executing') return 'running';
  return 'queued';
}

function needsFromPlan(plan, sessionId) {
  const needs = [];
  if (plan?.delegationOrigin?.phase === 'awaiting_approval') {
    needs.push({ approvalId: `${sessionId}:plan_approval`, kind: 'plan_approval' });
  }
  if (plan?.runner?.status === 'waiting_user') {
    needs.push({ approvalId: `${sessionId}:question`, kind: 'question' });
  }
  return needs;
}

function leafFacts(plan) {
  const leaves = [];
  const stack = Array.isArray(plan?.tasks) ? [...plan.tasks] : [];
  while (stack.length > 0) {
    const task = stack.shift();
    if (!task || typeof task !== 'object') continue;
    const subtasks = Array.isArray(task.subtasks) ? task.subtasks : [];
    if (subtasks.length > 0) {
      stack.push(...subtasks);
      continue;
    }
    const taskId = text(task.taskId);
    if (!taskId) continue;
    leaves.push({
      taskId,
      status: task.status === 'completed' ? 'completed' : (text(task.status) || 'pending'),
      ...(text(task.updatedAt) ? { updatedAt: text(task.updatedAt) } : {}),
    });
  }
  return leaves;
}

function latestCompletion(leaves) {
  let best = '';
  let bestMs = -Infinity;
  for (const leaf of leaves) {
    if (leaf.status !== 'completed' || !leaf.updatedAt) continue;
    const ms = Date.parse(leaf.updatedAt);
    if (!Number.isFinite(ms) || ms < bestMs) continue;
    bestMs = ms;
    best = leaf.updatedAt;
  }
  return best;
}

function waitingOnUser(session) {
  if (session?.status === 'waiting_user') return true;
  for (const item of Array.isArray(session?.needsUser) ? session.needsUser : []) {
    if (item && WAITING_KINDS.has(item.kind)) return true;
  }
  return false;
}

function progressAnchor(session) {
  for (const value of [session?.lastProgressAt, session?.progressEmittedAt, session?.startedAt]) {
    const ms = parseTime(value);
    if (ms == null) continue;
    return { ms, token: anchorToken(value, ms) };
  }
  return null;
}

function resolveNow(now) {
  if (now == null) return Date.now();
  return parseTime(now);
}

function parseTime(value) {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  const ms = Date.parse(value.trim());
  return Number.isFinite(ms) ? ms : null;
}

function anchorToken(value, ms) {
  if (typeof value === 'string' && value.trim()) return value.trim();
  return new Date(ms).toISOString();
}

function taskKeyOf(record) {
  return text(record?.taskId) || text(record?.planId) || text(record?.sessionId);
}

function sameTask(entry, taskKey) {
  const entryKey = taskKeyOf(entry);
  if (!entryKey) return true;
  return entryKey === taskKey;
}

function normalizeCause(value) {
  return text(value).replace(/\s+/g, ' ').toLowerCase();
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

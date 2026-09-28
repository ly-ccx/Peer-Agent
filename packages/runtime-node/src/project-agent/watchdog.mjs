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
 * 同一任务（taskId，否则 planId，否则 sessionId）且同一原因达到 3 次时停止自动重试。
 */
export function assessSameCause(session, failure = describeFailure(session)) {
  const cause = normalizeCause(failure?.cause) || describeFailure(session).cause;
  const taskKey = taskKeyOf(session);
  if (!cause) {
    return { taskKey, cause: '', count: 0, askUser: false, stopAutoRetry: false };
  }
  let count = 1;
  for (const entry of Array.isArray(session?.failureLog) ? session.failureLog : []) {
    if (!sameTask(entry, taskKey)) continue;
    const entryCause = normalizeCause(entry?.cause) || describeFailure(entry).cause;
    if (entryCause === cause) count += 1;
  }
  const askUser = count >= SAME_CAUSE_RETRY_LIMIT;
  return { taskKey, cause, count, askUser, stopAutoRetry: askUser };
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

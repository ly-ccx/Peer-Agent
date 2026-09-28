import { mapDelegationEvents } from './event-mapper.mjs';
import { STALL_WINDOW_MS } from './watchdog.mjs';

/**
 * 记住上一份会话事实，把新的停滞和失败事件交出去。
 * 调用方负责写进收件箱并唤醒代理。这里不读盘。
 */
export function createWatchPublisher({
  now = () => new Date().toISOString(),
  pollMs = 30_000,
  minMs = 1000,
  windowMs = STALL_WINDOW_MS,
} = {}) {
  const snapshots = new Map();

  function publish(workspaceId, facts) {
    const current = normalizeFacts(facts);
    const previous = snapshots.get(workspaceId) || { sessions: [] };
    const at = iso(now);
    const events = mapDelegationEvents(previous, current, { now: () => at });
    snapshots.set(workspaceId, retain(previous, current, events, at));
    return events;
  }

  function nextDelay(workspaceId, at = iso(now)) {
    const atMs = Date.parse(at);
    let delay = pollMs;
    if (!Number.isFinite(atMs)) return delay;
    for (const session of snapshots.get(workspaceId)?.sessions || []) {
      if (session?.status !== 'running') continue;
      if (waiting(session)) continue;
      const anchor = Date.parse(session.lastProgressAt || session.progressEmittedAt || session.startedAt || '');
      if (!Number.isFinite(anchor)) continue;
      const remaining = anchor + windowMs - atMs;
      if (remaining <= 0) continue;
      delay = Math.min(delay, remaining);
    }
    return Math.max(minMs, delay);
  }

  function forget(workspaceId) {
    snapshots.delete(workspaceId);
  }

  return { publish, nextDelay, forget };
}

function retain(previous, current, events, at) {
  const prior = new Map((previous.sessions || []).map((session) => [session.sessionId, session]));
  return {
    sessions: current.sessions.map((session) => {
      const old = prior.get(session.sessionId);
      const stalled = events.find((event) => event.sessionId === session.sessionId && event.kind === 'stalled');
      const progressed = events.some((event) => event.sessionId === session.sessionId && event.kind === 'progress');
      const stallId = text(stalled?.payload?.stallId) || text(old?.stallId);
      const progressEmittedAt = progressed
        ? at
        : (text(old?.progressEmittedAt) || text(session.progressEmittedAt));
      return {
        ...session,
        ...(stallId ? { stallId } : {}),
        ...(progressEmittedAt ? { progressEmittedAt } : {}),
      };
    }),
  };
}

function waiting(session) {
  if (session?.status === 'waiting_user') return true;
  return (Array.isArray(session?.needsUser) ? session.needsUser : [])
    .some((item) => item?.kind === 'approval' || item?.kind === 'question' || item?.kind === 'plan_approval');
}

function normalizeFacts(facts) {
  const sessions = Array.isArray(facts?.sessions) ? facts.sessions : [];
  return {
    sessions: sessions.filter((session) => session && typeof session.sessionId === 'string' && session.sessionId),
  };
}

function iso(now) {
  const value = typeof now === 'function' ? now() : now;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && value.trim()) return value.trim();
  return new Date().toISOString();
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

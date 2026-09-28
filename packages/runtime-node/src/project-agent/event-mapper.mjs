import { createHash } from 'node:crypto';

import { assessSameCause, assessStall, describeFailure } from './watchdog.mjs';

/**
 * 任务事实的变化映射成收件箱事件。纯函数：同一对前后事实得到同一批 eventId。
 * 进度只在叶子新完成时产生，并且同一会话 30 秒内只产生一条。
 * 被节流时宿主应保持上一份事实，稍后再映射，否则这次完成不会再出现。
 * stalled：显式 stallId 优先。否则 running、10 分钟无进展、且没有待批准或提问时，
 * 由 watchdog 给出 stallId。只和上一份事实里已经记下的 stallId 比较。
 */

export const PROGRESS_THROTTLE_MS = 30_000;

const NEED_KINDS = new Set(['approval', 'question', 'plan_approval']);
const TERMINAL_KINDS = new Set(['failed', 'cancelled', 'interrupted']);

export function delegationEventId({ sessionId, kind, version, approvalId } = {}) {
  const token = approvalId != null && String(approvalId) !== ''
    ? String(approvalId)
    : String(version ?? '');
  return createHash('sha256').update(`${sessionId}\0${kind}\0${token}`).digest('hex');
}

export function mapDelegationEvents(previousFacts, currentFacts, {
  now = () => new Date().toISOString(),
  progressThrottleMs = PROGRESS_THROTTLE_MS,
} = {}) {
  const at = iso(now);
  const previous = indexSessions(previousFacts);
  const events = [];
  for (const session of listSessions(currentFacts)) {
    events.push(...diffSession(previous.get(session.sessionId) ?? null, session, { at, progressThrottleMs }));
  }
  return events;
}

function diffSession(prior, session, { at, progressThrottleMs }) {
  if (!session?.sessionId) return [];
  const events = [];
  if (!prior) {
    events.push(event(session, { kind: 'session_started', version: session.version ?? 1, at, payload: { status: session.status ?? null } }));
  }
  const progress = progressEvent(prior, session, { at, progressThrottleMs });
  if (progress) events.push(progress);
  for (const item of newNeeds(prior, session)) {
    events.push(event(session, {
      kind: 'needs_user',
      approvalId: item.approvalId,
      at,
      payload: { need: item.kind },
    }));
  }
  if (verdictChanged(prior, session)) {
    events.push(event(session, {
      kind: 'result_ready',
      version: session.verdict?.version ?? session.version ?? 1,
      at,
      payload: {
        outcome: session.verdict?.outcome ?? null,
        ...(Array.isArray(session.verdict?.evidenceRefs)
          ? { evidenceRefs: session.verdict.evidenceRefs.filter((ref) => typeof ref === 'string').slice(0, 20) }
          : {}),
      },
    }));
  }
  if (prior && TERMINAL_KINDS.has(session.status) && prior.status !== session.status) {
    events.push(event(session, {
      kind: session.status,
      version: session.version ?? 1,
      at,
      payload: terminalPayload(session),
    }));
  }
  for (const item of newIds(prior?.interventions, session.interventions)) {
    events.push(event(session, {
      kind: 'user_intervened',
      version: item.id,
      at,
      payload: { messageId: item.id },
    }));
  }
  const stallId = stallIdOf(session, at);
  if (stallId && stallId !== prior?.stallId) {
    events.push(event(session, {
      kind: 'stalled',
      version: stallId,
      at,
      payload: { stallId },
    }));
  }
  return events;
}

function stallIdOf(session, at) {
  if (typeof session?.stallId === 'string' && session.stallId) return session.stallId;
  const assessed = assessStall(session, { now: at });
  return assessed.stalled ? assessed.stallId : null;
}

function terminalPayload(session) {
  const payload = { status: session.status };
  if (session.status !== 'failed' && session.status !== 'interrupted') return payload;
  const failure = describeFailure(session);
  if (!failure.summary) return payload;
  payload.summary = failure.summary;
  if (failure.reason) payload.reason = failure.reason;
  if (failure.lastError) payload.lastError = failure.lastError;
  if (failure.cause) payload.cause = failure.cause;
  const same = assessSameCause(session, failure);
  if (same.count > 0) payload.sameCauseCount = same.count;
  if (same.askUser) {
    payload.stopAutoRetry = true;
    payload.askUser = true;
  }
  return payload;
}

function progressEvent(prior, session, { at, progressThrottleMs }) {
  if (!prior) return null;
  const fresh = [...completedIds(session)].filter((id) => !completedIds(prior).has(id)).sort();
  if (fresh.length === 0) return null;
  const last = Date.parse(prior.progressEmittedAt || '');
  const current = Date.parse(at);
  if (Number.isFinite(last) && Number.isFinite(current) && current - last < progressThrottleMs) return null;
  return event(session, {
    kind: 'progress',
    version: fresh.join(','),
    at,
    payload: { leafIds: fresh },
  });
}

function completedIds(session) {
  const ids = new Set();
  for (const leaf of Array.isArray(session?.leaves) ? session.leaves : []) {
    if (leaf?.status === 'completed' && typeof leaf.taskId === 'string' && leaf.taskId) ids.add(leaf.taskId);
  }
  return ids;
}

function newNeeds(prior, session) {
  const seen = new Set((Array.isArray(prior?.needsUser) ? prior.needsUser : []).map((item) => item?.approvalId).filter(Boolean));
  const items = [];
  for (const item of Array.isArray(session?.needsUser) ? session.needsUser : []) {
    if (!item || !NEED_KINDS.has(item.kind) || typeof item.approvalId !== 'string' || !item.approvalId) continue;
    if (seen.has(item.approvalId)) continue;
    items.push(item);
  }
  return items;
}

function newIds(previous, current) {
  const seen = new Set((Array.isArray(previous) ? previous : []).map((item) => item?.id).filter(Boolean));
  return (Array.isArray(current) ? current : []).filter((item) => item?.id && !seen.has(item.id));
}

function verdictChanged(prior, session) {
  const next = session?.verdict;
  if (!next || typeof next !== 'object') return false;
  const previous = prior?.verdict;
  if (!previous) return true;
  return previous.outcome !== next.outcome || previous.version !== next.version;
}

function event(session, { kind, version, approvalId, at, payload }) {
  const token = approvalId != null && String(approvalId) !== '' ? String(approvalId) : String(version ?? '');
  return {
    eventId: delegationEventId({ sessionId: session.sessionId, kind, version: token, approvalId }),
    kind,
    sessionId: session.sessionId,
    workspaceId: session.workspaceId,
    at,
    ...(session.planId ? { planId: session.planId } : {}),
    ...(approvalId ? { approvalId: String(approvalId) } : { version: token }),
    payload: payload ?? null,
  };
}

function listSessions(facts) {
  const sessions = Array.isArray(facts?.sessions) ? facts.sessions : [];
  return sessions.filter((session) => session && typeof session.sessionId === 'string' && session.sessionId);
}

function indexSessions(facts) {
  return new Map(listSessions(facts).map((session) => [session.sessionId, session]));
}

function iso(now) {
  const value = typeof now === 'function' ? now() : now;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && value.trim()) return value.trim();
  return new Date().toISOString();
}

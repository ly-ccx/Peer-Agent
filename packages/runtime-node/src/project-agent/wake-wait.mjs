/** Waiting is a host decision over current owned facts, never inferred from empty prose. */
const ADVANCING = new Set(['queued', 'starting', 'running', 'verifying']);
const ROUTINE = new Set(['session_started', 'session_spawned', 'session_running', 'session_resumed', 'progress', 'session_progress']);

export function hostWakeWait(job, work, sessions) {
  if (job.kind !== 'wake' || job.interactive || job.continuation || job.userInputs?.length
    || !job.events?.length || !work || work.recovery || work.stopScope === 'work'
    || job.events.some(event => !ROUTINE.has(event.kind) || !event.sessionId)
    || sessions.some(row => work.sessionIds?.includes(row.sessionId)
      && (row.needsUser || ['waiting_user', 'waiting_agent', 'result_ready', 'interrupted'].includes(row.status)))) return null;
  const ids = [...new Set(job.events.map(event => event.sessionId))];
  return ids.every(id => work.sessionIds?.includes(id)
    && sessions.some(row => row.sessionId === id && ADVANCING.has(row.status) && !row.needsUser))
    ? { sessionIds: ids, source: 'host' } : null;
}

export async function admitSessionWait(input, view, getSession) {
  if (!view.workId || view.currentInputAnchors.length || view.turnKind !== 'wake' || !view.events.length
    || typeof getSession !== 'function') return { ok: false, error: 'background_wait_required' };
  for (const sessionId of input.sessionIds) {
    const row = await getSession({ sessionId });
    if (!row || row.workspaceId !== view.workspaceId || row.origin?.parentConversationId !== view.conversationId
      || row.origin?.workId !== view.workId) return { ok: false, error: 'out_of_scope' };
    if (!ADVANCING.has(row.status) || row.needsUser) return { ok: false, error: 'session_not_advancing', sessionId, status: row.status };
  }
  return { ok: true, kind: 'project_agent_wait', sessionIds: input.sessionIds };
}

export function waitResult(result) {
  if (typeof result === 'string') { try { return waitResult(JSON.parse(result)); } catch { return null; } }
  if (!result || result.ok === false || result.success === false || ['failed', 'denied', 'cancelled'].includes(result.status)) return null;
  if (result.ok === true && result.kind === 'project_agent_wait' && Array.isArray(result.sessionIds) && result.sessionIds.length) return result;
  return waitResult(result.output ?? result.outputPreview?.legacyResult ?? result.legacyResult);
}

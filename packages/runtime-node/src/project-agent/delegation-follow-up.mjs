import { createHash } from 'node:crypto';
import { resolveUserAnchors } from './user-anchor.mjs';

const correctable = new Set(['anchor_not_found', 'anchor_not_user_input', 'anchor_ambiguous', 'anchor_out_of_scope']);
const parse = value => { if (typeof value !== 'string') return value; try { return JSON.parse(value); } catch { return null; } };
const stable = value => value && typeof value === 'object' ? Array.isArray(value) ? value.map(stable)
  : Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const digest = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');

/** Read actual Tool Results. A missing receipt never proves an unexecuted write. */
function receipt(value) {
  let failed;
  for (let n = 0; n < 8; n++) {
    value = parse(value);
    if (!value || typeof value !== 'object') return { ok: false, error: 'execution_outcome_unknown' };
    if (['failed', 'denied', 'cancelled'].includes(value.status)) failed = value.status;
    const nested = value.output ?? value.outputPreview?.legacyResult ?? value.legacyResult;
    if (nested == null) return failed ? { ...value, ok: false, error: value.error || failed } : value;
    value = nested;
  }
  return { ok: false, error: 'execution_outcome_unknown' };
}

/** Pending dispatches are responsibility facts, never an instruction to execute. */
export function delegationFollowUp(previous, rounds, messages, turnId) {
  const pending = new Map((previous?.blockers || []).map(row => [row.taskKey, row]));
  let ordinal = 0;
  for (const call of (rounds || []).flatMap(round => round.toolCalls || [])) {
    ordinal++;
    const name = call.name?.replace(/^local\.delegation\./, ''), input = parse(call.input);
    const task = name === 'spawn_session' ? input : name === 'coordinate_work' && ['parallel', 'replace'].includes(input?.action) ? input.task : null;
    if (!task?.anchorMessageIds?.length) continue;
    const resolved = resolveUserAnchors(task.anchorMessageIds, messages, 'anchorMessageIds');
    const action = name === 'spawn_session' ? input.supersedes ? 'replace' : 'parallel' : input.action;
    const { supersedes, anchorMessageIds, ...spec } = task;
    const sessionId = input.sessionId || supersedes;
    const anchors = resolved.ok ? resolved.ids : anchorMessageIds;
    // The rejected anchor is the field under repair. Recovery identity is the task body without it.
    const recoveryKey = digest({ action, sessionId, task: spec });
    const taskKey = digest({ action, sessionId, task: { ...spec, anchorMessageIds: anchors } });
    const result = receipt(call.result);
    if (result.ok !== false && !result.error && typeof result.sessionId === 'string' && result.sessionId) {
      pending.delete(taskKey);
      for (const [key, row] of [...pending]) {
        if (row.recoveryKey === recoveryKey && correctable.has(row.error)) pending.delete(key);
      }
    } else {
      const error = typeof result.error === 'string' ? result.error.slice(0, 160) : 'execution_outcome_unknown';
      pending.set(taskKey, { taskKey, recoveryKey, sourceTurnId: turnId, toolCallId: call.toolCallId || call.result?.toolCallId || `${turnId}:${ordinal}`,
        action, error, retryable: correctable.has(error), ...(typeof result.operationId === 'string' ? { operationId: result.operationId } : {}) });
    }
  }
  return pending.size ? { blockers: [...pending.values()] } : undefined;
}

/** Durable transition + current execution binding prove admission; prose never does. */
export function reconcileDelegationFollowUp(pending, state, workId) {
  let changed = false;
  const blockers = pending.blockers.map(blocker => {
    const decision = state.decisions?.[blocker.operationId], transition = state.transitions?.[blocker.operationId];
    const mandate = state.mandates?.[workId], sessionId = transition?.replacementSessionId;
    const binding = mandate?.executionBindings?.[sessionId];
    if (!decision || decision.workId !== workId || transition?.workId !== workId
      || decision.action !== blocker.action || transition.action !== blocker.action
      || transition.phase !== 'completed' || !sessionId || !mandate?.sessionIds.includes(sessionId)
      || decision.goalRevision !== mandate.goalRevision || transition.expectedGoalRevision !== mandate.goalRevision
      || binding?.workId !== workId || binding.sessionId !== sessionId
      || binding.goalRevision !== mandate.goalRevision || binding.executionEpoch !== transition.executionEpoch) return blocker;
    const delivered = Object.values(state.deliveries || {}).some(row => row.state === 'delivered'
      && row.message?.kind === 'agent_reply' && row.message.meta?.workId === workId && row.message.sources?.includes(sessionId)
      && row.message.meta.sessionStates?.some(source => source.sessionId === sessionId && source.sourceRevision));
    if (delivered) { changed = true; return null; }
    if (blocker.error === 'delegation_receipt_reconciled') return blocker;
    changed = true;
    return { ...blocker, error: 'delegation_receipt_reconciled', retryable: true, sessionId };
  }).filter(Boolean);
  return changed ? blockers.length ? { blockers } : undefined : pending;
}

/** Legacy failure adoption is conservative and never changes the original records. */
export function legacyDelegationFollowUp(work, checkpoint, messages) {
  if (checkpoint?.outcome?.reason !== 'work_disposition_required') return undefined;
  const history = messages.filter(row => row.kind === 'agent_turn' && row.meta?.workId === work.workId);
  let pending;
  for (const row of history) pending = delegationFollowUp(pending, row.rounds, messages, row.turnId || row.id);
  return delegationFollowUp(pending, checkpoint.outcome.rounds, messages, checkpoint.outcome.turnId);
}

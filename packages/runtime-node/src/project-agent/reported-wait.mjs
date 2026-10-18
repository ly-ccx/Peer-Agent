import { sameSessionObservation } from './session-observation-revision.mjs';
function receipt(value) {
  if (typeof value === 'string') { try { return receipt(JSON.parse(value)); } catch { return null; } }
  if (!value || value.ok === false || value.success === false || value.error
    || ['failed', 'denied', 'cancelled'].includes(value.status)) return null;
  const nested = value.output ?? value.outputPreview?.legacyResult ?? value.legacyResult;
  return nested != null ? receipt(nested) : value;
}

/** A duplicate report is a wait only when canonical delivery and source facts agree. */
export function reportedWaitFor({ job, outcome, state, messages, sessions }) {
  if (outcome.failed || outcome.stopped || outcome.yielded || outcome.deliveryPending) return null;
  const calls = (outcome.rounds || []).flatMap(round => round.toolCalls || []);
  const posts = calls.filter(call => call.name === 'post_reply').map(call => receipt(call.result)).filter(Boolean);
  if (!posts.length) return null;
  const ids = [...new Set(posts.flatMap(post => post.suppressed ? post.reportedReplyIds || [] : post.message?.id ? [post.message.id] : []))];
  if (!ids.length) return null;
  const replies = ids.map(id => messages.find(message => message.id === id && message.kind === 'agent_reply'
    && state.deliveries[id]?.state === 'delivered'));
  if (replies.some(reply => !reply)) return null;
  const question = posts.some(post => post.question || post.message?.question);
  if (!question && (job.kind !== 'wake' || job.userInputs?.length || !posts.every(post => post.suppressed))) return null;
  const facts = posts.flatMap(post => post.sessionStates || post.message?.meta?.sessionStates || []);
  if (!facts.length || !facts.every(fact => fact.sourceRevision && sessions.some(row => sameSessionObservation(row, fact))
    && replies.some(reply => reply.meta?.sessionStates?.some(source => sameSessionObservation(source, fact))))) return null;
  return { replyIds: ids, sessionStates: facts, waitingUser: question };
}

export function reportedWaitCurrent(wait, sessions) {
  return Boolean(wait?.sessionStates?.length && wait.sessionStates.every(fact => sessions.some(row => sameSessionObservation(row, fact))));
}

import { createHash } from 'node:crypto';

const VOLATILE = /^(id|.*Id|.*At|.*Ms|.*Ref|.*Refs|seq|version|revision|duration|usage|timing|timestamp)$/;
function material(value) {
  if (Array.isArray(value)) return value.map(material);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
    .filter(key => !VOLATILE.test(key)).map(key => [key, material(value[key])]));
  if (typeof value === 'string') {
    try { const parsed = JSON.parse(value); if (parsed && typeof parsed === 'object') return material(parsed); } catch { /* ordinary factual text */ }
    return value.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, '<id>')
      .replace(/\bcall_[A-Za-z0-9_-]{12,}/g, 'call_<id>');
  }
  return value;
}
export function progressFingerprint(rounds, roster) {
  const calls = (rounds || []).flatMap(round => round.toolCalls || []).map(call => ({ name: call.name, input: call.input, result: call.result }));
  // Repeating or reordering the same observations does not add a new fact.
  // Keep arrays inside a result intact: their ordering may carry meaning.
  const factSet = values => [...new Set(values.map(value => JSON.stringify(material(value))))].sort();
  const rows = Array.isArray(roster) ? roster : roster?.items || roster?.sessions;
  const facts = { calls: factSet(calls), roster: rows ? factSet(rows) : material(roster) };
  return createHash('sha256').update(JSON.stringify(facts)).digest('hex');
}
export function progressFacts(rounds, roster) {
  const rows = Array.isArray(roster) ? roster : roster?.items || roster?.sessions || [];
  const observations = rounds.flatMap(round => round.toolCalls || []).map(call => {
    let result = call.result;
    if (typeof result === 'string') { try { result = JSON.parse(result); } catch { /* factual text */ } }
    // Retrying the same failed operation with another path or call ID is not new evidence.
    const failed = result?.ok === false || result?.success === false || ['failed', 'denied', 'cancelled'].includes(result?.status);
    return failed ? { name: call.name, error: result.error || result.code || result.status || 'failed' }
      : { name: call.name, input: ['get_session', 'get_verification_detail'].includes(call.name)
        || call.name === 'coordinate_work' && call.input?.action === 'query' ? undefined : call.input, result };
  });
  return [...new Set([...observations, ...rows].map(row => createHash('sha256').update(JSON.stringify(material(row))).digest('hex')))].sort();
}
export function continuationDecision({ previous = {}, rounds = [], roster, yielded = false, stopped = false, budgetAvailable = true }) {
  if (stopped) return { end: 'user_stopped', state: 'paused' };
  if (!budgetAvailable) return { end: 'budget_limited', state: 'budget_limited' };
  const fingerprint = progressFingerprint(rounds, roster);
  const observations = progressFacts(rounds, roster);
  const seen = previous.progressFacts || [];
  const novelty = observations.some(fact => !seen.includes(fact));
  const repeated = seen.length ? !novelty : previous.fingerprint === fingerprint;
  const repeats = repeated ? (previous.repeats || 0) + 1 : 0;
  const history = [...new Set([...seen, ...observations])].slice(-512);
  const tools = rounds.flatMap(round => round.toolCalls || []);
  // A host-requested yield may precede the first provider request. It is not a finished reply.
  if (yielded && tools.length === 0) return { end: 'yielded', state: 'runnable', fingerprint: previous.fingerprint, repeats: previous.repeats || 0 };
  if (repeats >= 2) return { end: 'no_progress', state: 'blocked_system', fingerprint, repeats, progressFacts: history };
  if (!yielded || tools.length === 0) return { end: 'reply_committed', state: 'delivered', fingerprint, repeats, progressFacts: history };
  return { end: 'yielded', state: 'runnable', fingerprint, repeats, progressFacts: history };
}

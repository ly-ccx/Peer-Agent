import { createHash } from 'node:crypto';

const VOLATILE = /^(id|.*Id|.*At|.*Ms|.*Ref|.*Refs|seq|version|revision|duration|usage|timing|timestamp)$/;
function material(value) {
  if (Array.isArray(value)) return value.map(material);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
    .filter(key => !VOLATILE.test(key)).map(key => [key, material(value[key])]));
  if (typeof value === 'string') {
    try { const parsed = JSON.parse(value); if (parsed && typeof parsed === 'object') return material(parsed); } catch { /* ordinary factual text */ }
    return value.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, '<id>');
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
export function continuationDecision({ previous = {}, rounds = [], roster, yielded = false, stopped = false, budgetAvailable = true }) {
  if (stopped) return { end: 'user_stopped', state: 'paused' };
  if (!budgetAvailable) return { end: 'budget_limited', state: 'budget_limited' };
  const fingerprint = progressFingerprint(rounds, roster);
  const repeats = previous.fingerprint === fingerprint ? (previous.repeats || 0) + 1 : 0;
  const tools = rounds.flatMap(round => round.toolCalls || []);
  // A host-requested yield may precede the first provider request. It is not a finished reply.
  if (yielded && tools.length === 0) return { end: 'yielded', state: 'runnable', fingerprint: previous.fingerprint, repeats: previous.repeats || 0 };
  if (repeats >= 2) return { end: 'no_progress', state: 'blocked_system', fingerprint, repeats };
  if (!yielded || tools.length === 0) return { end: 'reply_committed', state: 'delivered', fingerprint, repeats };
  return { end: 'yielded', state: 'runnable', fingerprint, repeats };
}

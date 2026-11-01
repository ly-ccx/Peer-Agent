import { createHash } from 'node:crypto';
import { normalizedProgressObservations } from './progress-policy.mjs';

export const progressFacts = (rounds = [], roster) => normalizedProgressObservations(rounds, roster).map(row => row.fingerprint).sort();
export const progressFingerprint = (rounds, roster) => createHash('sha256').update(JSON.stringify(progressFacts(rounds, roster))).digest('hex');

/** Scheduling slices consume normalized host observations, not operation IDs or model explanations. */
export function continuationDecision({ previous = {}, rounds = [], roster, yielded = false, stopped = false, budgetAvailable = true }) {
  if (stopped) return { end: 'user_stopped', state: 'paused' };
  if (!budgetAvailable) return { end: 'budget_limited', state: 'budget_limited' };
  const records = normalizedProgressObservations(rounds, roster), observations = records.map(row => row.fingerprint).sort();
  const fingerprint = createHash('sha256').update(JSON.stringify(observations)).digest('hex');
  const seen = previous.progressFacts || [], novelty = observations.some(fact => !seen.includes(fact));
  const repeated = seen.length ? !novelty : previous.fingerprint === fingerprint;
  const repeats = repeated ? (previous.repeats || 0) + 1 : 0;
  const history = [...new Set([...seen, ...observations])].slice(-512);
  const tools = rounds.flatMap(round => round.toolCalls || []);
  if (yielded && tools.length === 0) return { end: 'yielded', state: 'runnable', fingerprint: previous.fingerprint, repeats: previous.repeats || 0 };
  const progressObservation = { observed: records.filter(row => row.kind === 'observed').length,
    admitted: records.filter(row => row.kind === 'admitted').length, advanced: records.filter(row => row.kind === 'advanced').length };
  const fields = { fingerprint, repeats, progressFacts: history, progressObservation };
  if (repeats >= 2) return { end: 'no_progress', state: 'blocked_system', ...fields };
  if (!yielded || tools.length === 0) return { end: 'reply_committed', state: 'delivered', ...fields };
  return { end: 'yielded', state: 'runnable', ...fields };
}

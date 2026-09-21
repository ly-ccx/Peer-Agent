import { evaluateUiDelivery } from '@peer-agent/protocol';

/** Read-only host projection. Leaf/quality writes cannot manufacture UI completion.
 * The callback receives the candidate plan so authority reads never recurse through
 * getPlan. Neither this port nor the returned snapshot is accepted from model args.
 */
export function projectUiCompletion(plan, readUiDelivery, readEvidenceIndex) {
  if (plan?.status !== 'completed' || typeof readUiDelivery !== 'function') return plan;
  let passed = false;
  try {
    const snapshot = readUiDelivery(plan);
    if (snapshot && typeof snapshot.then === 'function') {
      // An async host is not this synchronous port; observe rejection but fail closed.
      Promise.resolve(snapshot).catch(() => {});
    } else if (snapshot?.required === false) {
      return plan;
    } else if (snapshot?.required === true && Array.isArray(snapshot.requirements)
      && snapshot.requirements.length > 0 && Array.isArray(snapshot.observations)
      && Array.isArray(snapshot.judgments)) {
      const known = new Set(readEvidenceIndex()
        .filter(record => record.planId === plan.planId
          && (!plan.conversationId || record.conversationId === plan.conversationId))
        .map(record => record.evidenceRef));
      passed = evaluateUiDelivery(snapshot.requirements, snapshot.observations, snapshot.judgments, known).passed;
    }
  } catch { /* Unavailable or corrupt authority cannot grant completion. */ }
  const interrupted = plan.runner?.interruption
    && !(plan.runner.status === 'running' && plan.runner.interruption.recoverable === true);
  if (interrupted) return { ...plan, status: 'interrupted' };
  return passed ? plan : { ...plan, status: 'executing' };
}

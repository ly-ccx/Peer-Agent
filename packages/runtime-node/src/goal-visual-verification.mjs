import { randomUUID } from 'node:crypto';
import { needsIndependentVisualReview } from './goal-visual-repair.mjs';
import { goalPlanWaitsOnPreviewReview, goalPlanWaitsOnUser, listPreviewReviewPendingLeaves } from './goal-plan-store.mjs';

/** Run the existing verifier port when UI delivery is unmet and no mechanical
 * command/test/file gap remains. Pending manual confirmation does not skip review.
 * The report's passed flag never grants completion. This module owns cancellation
 * for reviews started both outside the pump (start) and inside a running session.
 */
export function createGoalVisualVerification({ goalPlanStore, verifierRunner, evaluateGate, timeoutMs = 120_000 }) {
  const active = new Map();
  const retained = new Map(); // A later pause/clear also revokes a completed visual assessment.
  function cancel(planId) {
    active.get(planId)?.abort();
    retained.get(planId)?.abort();
    retained.delete(planId);
  }
  // A current authority pass only releases deferred work. It never completes it.
  function releaseReviewedWork(plan, gate) {
    if (gate?.uiDeliveryRequired !== true) return false;
    if ((gate.unmet || []).some(item => item.kind === 'ui_delivery')) return false;
    const deferred = listPreviewReviewPendingLeaves(plan);
    if (!deferred.length) return false;
    for (const taskId of deferred) goalPlanStore.recordTaskEvidence(plan.planId, taskId, {
      status: 'pending', result: 'Independent review passed; finish the deferred task and record its evidence.',
    });
    return true;
  }
  function waitsOnUser(plan) {
    return goalPlanWaitsOnUser(plan)
      || (plan?.runner?.status === 'waiting_user' && !goalPlanWaitsOnPreviewReview(plan));
  }
  async function review(plan, gate) {
    if (waitsOnUser(plan)) return { gate, cancelled: true };
    if (releaseReviewedWork(plan, gate)) return { gate, resumeRemainingTasks: true };
    if (gate?.passed || !needsIndependentVisualReview(gate) || !verifierRunner?.runVerifier) return { gate };
    if (active.has(plan.planId)) return { gate, cancelled: true };
    cancel(plan.planId);
    const controller = new AbortController();
    active.set(plan.planId, controller);
    retained.set(plan.planId, controller);
    const signal = controller.signal;
    const timer = setTimeout(() => controller.abort(new Error('visual-review-timeout')), timeoutMs);
    const verifierRunId = `visual-verifier:${randomUUID()}`;
    goalPlanStore.recordVerifierRun?.(plan.planId, { verifierRunId, status: 'running',
      summary: 'Read-only visual verification', evidenceRefs: [] });
    let report;
    let failure;
    let onAbort;
    try {
      const aborted = new Promise((_, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
      });
      report = await Promise.race([Promise.resolve().then(() => {
        signal.throwIfAborted();
        return verifierRunner.runVerifier({ plan, gate, stage: 'visual', verifierRunId, signal });
      }), aborted]);
      signal.throwIfAborted();
    } catch (error) { failure = error; }
    finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      if (active.get(plan.planId) === controller) active.delete(plan.planId);
    }
    // A pause/clear must not be overwritten by the caller's terminal transition.
    const latest = goalPlanStore.getPlan(plan.planId);
    const cancelled = signal.aborted && signal.reason?.message !== 'visual-review-timeout';
    if (cancelled || !latest || ['paused', 'cancelled'].includes(latest.status)
      || latest.runner?.status === 'paused' || waitsOnUser(latest)) return { gate, cancelled: true };
    let currentGate = evaluateGate(latest);
    if (failure && currentGate.passed) currentGate = { ...currentGate, passed: false,
      unmet: [{ kind: 'ui_delivery', reason: 'visual_review_failed' }] };
    const resumeRemainingTasks = !failure && releaseReviewedWork(latest, currentGate);
    const passed = !failure && (currentGate.passed || resumeRemainingTasks);
    const evidenceRefs = Array.isArray(report?.evidenceRefs) ? report.evidenceRefs : [];
    const failureReason = failure?.message || (!passed && !resumeRemainingTasks
      ? (currentGate.unmet || []).map(item => `${item.kind}:${item.reason}`).filter(Boolean).join('; ')
      : undefined);
    // Findings/repair text stays in the host response, not the persisted Runner log.
    goalPlanStore.recordVerifierRun?.(plan.planId, { verifierRunId,
      status: passed ? 'passed' : 'failed',
      summary: failureReason || (resumeRemainingTasks ? 'Visual review passed; deferred work still needs evidence'
        : passed ? 'Visual completion gate passed' : 'Visual completion gate not satisfied'),
      failureReason,
      evidenceRefs, report: { passed, evidenceRefs, recommendedNextAction: resumeRemainingTasks ? 'continue' : passed ? 'complete' : 'repair' } });
    return {
      gate: currentGate,
      resumeRemainingTasks,
      report: failure || !report ? undefined : {
        ...report,
        passed: report?.passed === true,
        verdict: report?.verdict === 'inconclusive' ? 'inconclusive' : (report?.passed === true ? 'passed' : 'failed'),
        scene: report?.scene,
        artifactRef: report?.artifactRef,
        evidenceRefs,
        findings: Array.isArray(report?.findings) ? report.findings : [],
        repairSuggestions: Array.isArray(report?.repairSuggestions) ? report.repairSuggestions : [],
      },
      attempted: true,
    };
  }
  return { review, cancel };
}

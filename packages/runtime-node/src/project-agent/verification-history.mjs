import { criterionSourceRevision } from './criterion-review.mjs';

const clip = value => typeof value === 'string' ? value.slice(0, 400) : '';
const refs = (values, allowed) => (Array.isArray(values) ? values : [])
  .filter(ref => typeof ref === 'string' && allowed.has(ref)).slice(0, 12);

/**
 * Persisted review history explains attempts; it never supplies completion authority.
 * @returns {import('@peer-agent/protocol').VerificationAttemptDiagnostic[]}
 */
export function verificationHistory(plan, evidenceIndex = []) {
  const allowed = new Set(evidenceIndex);
  const revision = criterionSourceRevision(plan);
  const runs = (plan?.runner?.verifierRuns || [])
    .filter(run => run?.target?.kind === 'plan' && ['passed', 'failed'].includes(run.status)).slice(-3);
  return runs.map(run => {
    const report = run.report || {};
    const reviews = (plan.modelReviews || []).filter(row => row.verifierRunId === run.verifierRunId);
    const assessments = (items, idKey) => (Array.isArray(items) ? items : []).slice(0, 3).map(item => ({
      [idKey]: clip(item?.[idKey]), reason: clip(item?.reason), evidenceRefs: refs(item?.evidenceRefs, allowed),
    }));
    return {
      verifierRunId: clip(run.verifierRunId),
      status: run.status,
      diagnosticOnly: true,
      matchesCurrentSource: reviews.length ? reviews.every(row => row.sourceRevision === revision) : null,
      completedAt: clip(run.completedAt || run.updatedAt || run.createdAt),
      failureReason: clip(run.failureReason),
      failedCriteria: assessments(report.failedCriteria, 'criterionId'),
      missingEvidence: assessments(report.missingEvidence, 'taskId'),
      risks: (Array.isArray(report.risks) ? report.risks : []).slice(0, 3).map(clip),
      recommendedNextAction: clip(report.recommendedNextAction),
      evidenceRefs: refs(run.evidenceRefs, allowed),
    };
  });
}

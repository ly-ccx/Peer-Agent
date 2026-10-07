import { criterionSourceRevision } from './criterion-review.mjs';

/** Explicit, host-only repair of proven legacy model criteria. Never a global migration. */
export function createLegacyCriterionRecovery({ store, readProvenance, holdsLease = () => false, now = () => new Date().toISOString() }) {
  function audit(planId, criterionIds) {
    const plan = store.getPlan(planId);
    if (!plan || !plan.delegationOrigin?.readOnly || plan.resultAcceptance || ['cancelled', 'failed'].includes(plan.status)
      || ['paused', 'superseded'].includes(plan.delegationOrigin.phase)) return { ok: false, code: 'recovery_boundary' };
    const proof = readProvenance(plan);
    if (!proof?.noManualReviewPolicy || proof.planId !== planId || !proof.dispatchEvidenceRef || proof.userReviewRequested !== false) return { ok: false, code: 'criterion_origin_unknown' };
    const changes = [];
    for (const id of [...new Set(criterionIds)]) {
      const criterion = plan.successCriteria.find(row => row.id === id);
      if (!criterion || criterion.kind !== 'manual' || criterion.authority || plan.manualConfirmations?.some(row => row.criterionId === id || row.criterionIds?.includes(id))
        || !proof.modelCriteria?.some(row => row.id === id && row.description === criterion.description)) return { ok: false, code: 'manual_boundary', criterionId: id };
      changes.push({ ...criterion, kind: 'model_review', authority: { source: 'model', sourceRef: proof.dispatchEvidenceRef,
        version: 2, verifier: 'host_model', rationale: 'Audited legacy string criterion from model dispatch' } });
    }
    return { ok: true, planId, sourceRevision: criterionSourceRevision(plan), original: plan.successCriteria,
      changes, dispatchEvidenceRef: proof.dispatchEvidenceRef, at: now() };
  }
  function apply(auditRecord) {
    if (!auditRecord?.ok) throw new Error('criterion_audit_required');
    if (holdsLease(auditRecord.planId) !== true) throw new Error('criterion_recovery_lease_required');
    const verified = audit(auditRecord.planId, auditRecord.changes.map(row => row.id));
    if (!verified.ok || verified.sourceRevision !== auditRecord.sourceRevision || verified.dispatchEvidenceRef !== auditRecord.dispatchEvidenceRef) throw new Error('criterion_audit_changed');
    const plan = store.getPlan(auditRecord.planId);
    const changes = new Map(verified.changes.map(row => [row.id, row]));
    // revisePlan preserves previous content in the existing revision history. No human signature is written.
    return store.revisePlan(plan.planId, { successCriteria: plan.successCriteria.map(row => changes.get(row.id) || row) }, {
      changedBy: 'host:criterion-recovery', reason: JSON.stringify({ kind: 'legacy_criterion_recovery', ...verified }),
    });
  }
  return { audit, apply };
}

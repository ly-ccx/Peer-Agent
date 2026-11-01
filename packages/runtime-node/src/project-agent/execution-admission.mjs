// Process-local ports into the canonical device ledger. A port is never an ownership receipt.
const admissions = new Map();
export function registerExecutionAdmission(planId, port) {
  admissions.set(planId, port);
  return () => { if (admissions.get(planId) === port) admissions.delete(planId); };
}
export function executionAdmissionDenial(plan, action) {
  if (!plan?.planId || !plan.delegationOrigin) return null;
  const port = admissions.get(plan.planId);
  if (port) return port(plan, action);
  return plan.delegationOrigin.executionControl ? 'execution_resource_owner_unknown' : null;
}

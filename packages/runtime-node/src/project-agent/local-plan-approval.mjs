/** Project a persisted local decision into the existing GoalApproval contract.
 * This is historical plan admission, never capability permission or completion Evidence.
 */
export function readLocalPlanApproval(plan, approvalStore) {
  const origin = plan?.delegationOrigin;
  if (!origin?.workspaceId || !origin.sessionId || !plan.planId || !plan.conversationId
    || typeof approvalStore?.list !== 'function') return null;
  const record = approvalStore.list({ workspaceId: origin.workspaceId })
    .find(row => row.approvalId === `plan:${origin.sessionId}`);
  if (!record || record.state !== 'approved' || record.decidedBy !== 'local_ui'
    || record.kind !== 'plan_approval' || record.capabilityId !== 'goal.plan'
    || record.workspaceId !== origin.workspaceId || record.sessionId !== origin.sessionId
    || record.planId !== plan.planId || record.conversationId !== plan.conversationId
    || !/^[a-f0-9]{64}$/i.test(record.argsDigest || '')
    || typeof record.decidedAt !== 'string' || !Number.isFinite(Date.parse(record.decidedAt))) return null;
  return { decision: 'approve', confirmationId: record.approvalId,
    decidedBy: 'local_ui', decidedAt: record.decidedAt };
}

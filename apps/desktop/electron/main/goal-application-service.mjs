function assertFunction(value, label) {
  if (typeof value !== 'function') throw new TypeError(`${label} must be a function`);
  return value;
}

export function createGoalApplicationService({
  listPlanDetails,
  listPlanDetailsByConversation,
  countAwaitingApprovalsByConversation,
  getPlan,
  createPlan,
  revisePlan,
  recordApproval,
  setPlanStatus,
  recordManualConfirmation,
  recordTaskEvidence,
  deletePlan,
  startRunner,
  getRunnerState,
  pauseRunner,
  resumeRunner,
  clearRunner,
} = {}) {
  const ports = {
    listPlanDetails: assertFunction(listPlanDetails, 'listPlanDetails'),
    listPlanDetailsByConversation: assertFunction(
      listPlanDetailsByConversation,
      'listPlanDetailsByConversation',
    ),
    countAwaitingApprovalsByConversation: assertFunction(
      countAwaitingApprovalsByConversation,
      'countAwaitingApprovalsByConversation',
    ),
    getPlan: assertFunction(getPlan, 'getPlan'),
    createPlan: assertFunction(createPlan, 'createPlan'),
    revisePlan: assertFunction(revisePlan, 'revisePlan'),
    recordApproval: assertFunction(recordApproval, 'recordApproval'),
    setPlanStatus: assertFunction(setPlanStatus, 'setPlanStatus'),
    recordManualConfirmation: assertFunction(
      recordManualConfirmation,
      'recordManualConfirmation',
    ),
    recordTaskEvidence: assertFunction(recordTaskEvidence, 'recordTaskEvidence'),
    deletePlan: assertFunction(deletePlan, 'deletePlan'),
    startRunner: assertFunction(startRunner, 'startRunner'),
    getRunnerState: assertFunction(getRunnerState, 'getRunnerState'),
    pauseRunner: assertFunction(pauseRunner, 'pauseRunner'),
    resumeRunner: assertFunction(resumeRunner, 'resumeRunner'),
    clearRunner: assertFunction(clearRunner, 'clearRunner'),
  };

  function list(params) {
    if (params?.conversationId !== undefined) {
      return ports.listPlanDetailsByConversation(params.conversationId);
    }
    return ports.listPlanDetails();
  }

  function approve({ planId, approval }) {
    const plan = ports.recordApproval(planId, approval);
    if (approval?.decision === 'approve') {
      void ports.startRunner(planId);
    }
    return plan;
  }

  function remove({ planId }) {
    ports.deletePlan(planId);
    return ports.listPlanDetails();
  }

  return Object.freeze({
    list,
    awaitingCounts: () => ports.countAwaitingApprovalsByConversation(),
    get: ({ planId }) => ports.getPlan(planId),
    create: ({ draft }) => ports.createPlan(draft),
    revise: ({ planId, patch, reason, changedBy }) =>
      ports.revisePlan(planId, patch, { reason, changedBy }),
    approve,
    setStatus: ({ planId, status }) => ports.setPlanStatus(planId, status),
    recordManualConfirmation: ({ planId, confirmation }) =>
      ports.recordManualConfirmation(planId, confirmation),
    recordTaskEvidence: ({ planId, taskId, change }) =>
      ports.recordTaskEvidence(planId, taskId, change),
    remove,
    getRunnerState: ({ planId }) => ports.getRunnerState(planId),
    startRunner: ({ planId, options } = {}) => ports.startRunner(planId, options),
    pauseRunner: ({ planId }) => ports.pauseRunner(planId),
    resumeRunner: ({ planId, options } = {}) => ports.resumeRunner(planId, options),
    clearRunner: ({ planId }) => ports.clearRunner(planId),
  });
}

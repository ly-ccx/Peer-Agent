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
  markRequestedUserInput,
  recordManualConfirmation,
  recordTaskEvidence,
  deletePlan,
  retryHandoff,
  retrySourceHandoffs,
  declineSourceHandoffs,
  inspectSourceCheckout,
  commitSourceCheckout,
  stashSourceCheckout,
  resolveHandoffConflicts,
  previewHandoffMerge,
  cleanupHandoffPreview,
  isolate,
  openSite,
  discardLine,
  exportEvidence,
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
    markRequestedUserInput: assertFunction(
      markRequestedUserInput,
      'markRequestedUserInput',
    ),
    recordManualConfirmation: assertFunction(
      recordManualConfirmation,
      'recordManualConfirmation',
    ),
    recordTaskEvidence: assertFunction(recordTaskEvidence, 'recordTaskEvidence'),
    deletePlan: assertFunction(deletePlan, 'deletePlan'),
    retryHandoff: assertFunction(retryHandoff, 'retryHandoff'),
    retrySourceHandoffs,
    declineSourceHandoffs,
    inspectSourceCheckout,
    commitSourceCheckout,
    stashSourceCheckout,
    resolveHandoffConflicts,
    previewHandoffMerge,
    cleanupHandoffPreview,
    isolate: assertFunction(isolate, 'isolate'),
    openSite: assertFunction(openSite, 'openSite'),
    discardLine: assertFunction(discardLine, 'discardLine'),
    exportEvidence: assertFunction(exportEvidence, 'exportEvidence'),
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
    /**
     * 待验收点「继续讨论」：验收未通过，重开同一 plan，离开 result_ready。
     * runnerPatch 可选；store 会把 runner 置为 waiting_user。
     */
    markRequestedUserInput: ({ planId, runnerPatch } = {}) =>
      ports.markRequestedUserInput(planId, runnerPatch),
    recordManualConfirmation: ({ planId, confirmation }) =>
      ports.recordManualConfirmation(planId, confirmation),
    recordTaskEvidence: ({ planId, taskId, change }) =>
      ports.recordTaskEvidence(planId, taskId, change),
    remove,
    retryHandoff: ({ planId } = {}) => ports.retryHandoff(planId),
    inspectSourceCheckout: ({ planId, workspacePath } = {}) =>
      typeof ports.inspectSourceCheckout === 'function'
        ? ports.inspectSourceCheckout(planId, { workspacePath })
        : { ok: false, reason: 'unavailable' },
    commitSourceCheckout: ({ planId, message, permissionConfirmed, workspacePath } = {}) =>
      typeof ports.commitSourceCheckout === 'function'
        ? ports.commitSourceCheckout(planId, {
          message,
          permissionConfirmed: Boolean(permissionConfirmed),
          workspacePath,
        })
        : { ok: false, reason: 'unavailable' },
    stashSourceCheckout: ({ planId, permissionConfirmed, workspacePath } = {}) =>
      typeof ports.stashSourceCheckout === 'function'
        ? ports.stashSourceCheckout(planId, {
          permissionConfirmed: Boolean(permissionConfirmed),
          workspacePath,
        })
        : { ok: false, reason: 'unavailable' },
    retrySourceHandoffs: ({ planIds } = {}) =>
      typeof ports.retrySourceHandoffs === 'function'
        ? ports.retrySourceHandoffs(planIds)
        : { ok: false, reason: 'unavailable' },
    declineSourceHandoffs: ({ planIds } = {}) =>
      typeof ports.declineSourceHandoffs === 'function'
        ? ports.declineSourceHandoffs(planIds)
        : { ok: false, reason: 'unavailable' },
    // ADR 69 P2：收口决断与真机预览（可选端口，未接线的环境返回 ok:false）。
    resolveHandoffConflicts: ({ planId, resolutions, permissionConfirmed } = {}) =>
      typeof ports.resolveHandoffConflicts === 'function'
        ? ports.resolveHandoffConflicts(planId, resolutions, { permissionConfirmed: Boolean(permissionConfirmed) })
        : { ok: false, reason: 'unavailable' },
    previewHandoffMerge: ({ planId, resolutions } = {}) =>
      typeof ports.previewHandoffMerge === 'function'
        ? ports.previewHandoffMerge(planId, resolutions)
        : { ok: false, reason: 'unavailable' },
    cleanupHandoffPreview: ({ planId, previewPath } = {}) =>
      typeof ports.cleanupHandoffPreview === 'function'
        ? ports.cleanupHandoffPreview(planId, previewPath)
        : { ok: false, reason: 'unavailable' },
    isolate: ({ planId } = {}) => ports.isolate(planId),
    openSite: ({ planId, mode } = {}) => ports.openSite(planId, { mode }),
    discardLine: ({ planId, deleteBranch } = {}) =>
      ports.discardLine(planId, { deleteBranch: Boolean(deleteBranch) }),
    exportEvidence: ({ planId } = {}) => ports.exportEvidence(planId),
    getRunnerState: ({ planId }) => ports.getRunnerState(planId),
    startRunner: ({ planId, options } = {}) => ports.startRunner(planId, options),
    pauseRunner: ({ planId }) => ports.pauseRunner(planId),
    resumeRunner: ({ planId, options } = {}) => ports.resumeRunner(planId, options),
    clearRunner: ({ planId }) => ports.clearRunner(planId),
  });
}

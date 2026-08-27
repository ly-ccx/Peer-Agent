function assertFunction(value, label) {
  if (typeof value !== 'function') throw new TypeError(`${label} must be a function`);
  return value;
}

function owner(owner, register) {
  return Object.freeze({ owner, register });
}

export function createGoalIpcRegistrations({ goalPlans, goalRunner } = {}) {
  const plans = {
    list: assertFunction(goalPlans?.list, 'goalPlans.list'),
    awaitingCounts: assertFunction(goalPlans?.awaitingCounts, 'goalPlans.awaitingCounts'),
    get: assertFunction(goalPlans?.get, 'goalPlans.get'),
    create: assertFunction(goalPlans?.create, 'goalPlans.create'),
    revise: assertFunction(goalPlans?.revise, 'goalPlans.revise'),
    approve: assertFunction(goalPlans?.approve, 'goalPlans.approve'),
    setStatus: assertFunction(goalPlans?.setStatus, 'goalPlans.setStatus'),
    markRequestedUserInput: assertFunction(
      goalPlans?.markRequestedUserInput,
      'goalPlans.markRequestedUserInput',
    ),
    recordManualConfirmation: assertFunction(
      goalPlans?.recordManualConfirmation,
      'goalPlans.recordManualConfirmation',
    ),
    recordTaskEvidence: assertFunction(
      goalPlans?.recordTaskEvidence,
      'goalPlans.recordTaskEvidence',
    ),
    remove: assertFunction(goalPlans?.remove, 'goalPlans.remove'),
    retryHandoff: assertFunction(goalPlans?.retryHandoff, 'goalPlans.retryHandoff'),
    inspectSourceCheckout: goalPlans?.inspectSourceCheckout,
    commitSourceCheckout: goalPlans?.commitSourceCheckout,
    stashSourceCheckout: goalPlans?.stashSourceCheckout,
    retrySourceHandoffs: goalPlans?.retrySourceHandoffs,
    declineSourceHandoffs: goalPlans?.declineSourceHandoffs,
    // ADR 69 P2：收口决断与真机预览（可选，未接线的环境返回 ok:false，不 assert）。
    resolveHandoffConflicts: goalPlans?.resolveHandoffConflicts,
    previewHandoffMerge: goalPlans?.previewHandoffMerge,
    cleanupHandoffPreview: goalPlans?.cleanupHandoffPreview,
    isolate: assertFunction(goalPlans?.isolate, 'goalPlans.isolate'),
    openSite: assertFunction(goalPlans?.openSite, 'goalPlans.openSite'),
    discardLine: assertFunction(goalPlans?.discardLine, 'goalPlans.discardLine'),
    exportEvidence: assertFunction(goalPlans?.exportEvidence, 'goalPlans.exportEvidence'),
  };
  const runner = {
    getState: assertFunction(goalRunner?.getState, 'goalRunner.getState'),
    start: assertFunction(goalRunner?.start, 'goalRunner.start'),
    pause: assertFunction(goalRunner?.pause, 'goalRunner.pause'),
    resume: assertFunction(goalRunner?.resume, 'goalRunner.resume'),
    clear: assertFunction(goalRunner?.clear, 'goalRunner.clear'),
  };

  return Object.freeze([
    owner('goalPlans-ipc', (ipc) => {
      ipc.handle('goalPlans:list', (_event, payload) => plans.list(payload));
      ipc.handle('goalPlans:awaiting-counts', () => plans.awaitingCounts());
      ipc.handle('goalPlans:get', (_event, payload) => plans.get(payload));
      ipc.handle('goalPlans:create', (_event, payload) => plans.create(payload));
      ipc.handle('goalPlans:revise', (_event, payload) => plans.revise(payload));
      ipc.handle('goalPlans:approve', (_event, payload) => plans.approve(payload));
      ipc.handle('goalPlans:set-status', (_event, payload) => plans.setStatus(payload));
      ipc.handle('goalPlans:mark-requested-user-input', (_event, payload) =>
        plans.markRequestedUserInput(payload));
      ipc.handle('goalPlans:record-manual-confirmation', (_event, payload) =>
        plans.recordManualConfirmation(payload));
      ipc.handle('goalPlans:record-task-evidence', (_event, payload) =>
        plans.recordTaskEvidence(payload));
      ipc.handle('goalPlans:delete', (_event, payload) => plans.remove(payload));
      ipc.handle('goalPlans:retry-handoff', (_event, payload) => plans.retryHandoff(payload));
      const unavailable = () => ({ ok: false, reason: 'unavailable' });
      ipc.handle('goalPlans:inspect-source-checkout', (_event, payload) =>
        typeof plans.inspectSourceCheckout === 'function' ? plans.inspectSourceCheckout(payload) : unavailable());
      ipc.handle('goalPlans:commit-source-checkout', (_event, payload) =>
        typeof plans.commitSourceCheckout === 'function' ? plans.commitSourceCheckout(payload) : unavailable());
      ipc.handle('goalPlans:stash-source-checkout', (_event, payload) =>
        typeof plans.stashSourceCheckout === 'function' ? plans.stashSourceCheckout(payload) : unavailable());
      ipc.handle('goalPlans:retry-source-handoffs', (_event, payload) =>
        typeof plans.retrySourceHandoffs === 'function' ? plans.retrySourceHandoffs(payload) : unavailable());
      ipc.handle('goalPlans:decline-source-handoffs', (_event, payload) =>
        typeof plans.declineSourceHandoffs === 'function' ? plans.declineSourceHandoffs(payload) : unavailable());
      ipc.handle('goalPlans:resolve-handoff-conflicts', (_event, payload) =>
        typeof plans.resolveHandoffConflicts === 'function' ? plans.resolveHandoffConflicts(payload) : unavailable());
      ipc.handle('goalPlans:preview-handoff-merge', (_event, payload) =>
        typeof plans.previewHandoffMerge === 'function' ? plans.previewHandoffMerge(payload) : unavailable());
      ipc.handle('goalPlans:cleanup-handoff-preview', (_event, payload) =>
        typeof plans.cleanupHandoffPreview === 'function' ? plans.cleanupHandoffPreview(payload) : unavailable());
      ipc.handle('goalPlans:isolate', (_event, payload) => plans.isolate(payload));
      ipc.handle('goalPlans:open-site', (_event, payload) => plans.openSite(payload));
      ipc.handle('goalPlans:discard-line', (_event, payload) => plans.discardLine(payload));
      ipc.handle('goalPlans:export-evidence', (_event, payload) => plans.exportEvidence(payload));
    }),
    owner('goalRunner-ipc', (ipc) => {
      ipc.handle('goalRunner:get-state', (_event, payload) => runner.getState(payload));
      ipc.handle('goalRunner:start', (_event, payload = {}) => runner.start(payload));
      ipc.handle('goalRunner:pause', (_event, payload) => runner.pause(payload));
      ipc.handle('goalRunner:resume', (_event, payload = {}) => runner.resume(payload));
      ipc.handle('goalRunner:clear', (_event, payload) => runner.clear(payload));
    }),
  ]);
}

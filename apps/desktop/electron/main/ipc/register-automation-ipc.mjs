function required(value, label) {
  if (typeof value !== 'function') throw new TypeError(`${label} must be a function`);
  return value;
}

function owner(name, register) {
  return Object.freeze({ owner: name, register });
}

export function createAutomationIpcRegistrations({ automations, proposals } = {}) {
  const api = Object.freeze({
    bootstrap: required(automations?.bootstrap, 'automations.bootstrap'),
    list: required(automations?.list, 'automations.list'),
    get: required(automations?.get, 'automations.get'),
    create: required(automations?.create, 'automations.create'),
    update: required(automations?.update, 'automations.update'),
    listRuns: required(automations?.listRuns, 'automations.listRuns'),
    getRun: required(automations?.getRun, 'automations.getRun'),
    runNow: required(automations?.runNow, 'automations.runNow'),
    retryRun: required(automations?.retryRun, 'automations.retryRun'),
    cancelRun: required(automations?.cancelRun, 'automations.cancelRun'),
    setRuntimePaused: required(automations?.setRuntimePaused, 'automations.setRuntimePaused'),
    actOnProposal: required(proposals?.act, 'proposals.act'),
  });

  return Object.freeze([owner('automations-ipc', (ipc) => {
    ipc.handle('automations:bootstrap', () => api.bootstrap());
    ipc.handle('automations:list', (_event, payload = {}) => api.list(payload));
    ipc.handle('automations:get', (_event, payload) => api.get(payload));
    ipc.handle('automations:create', (_event, payload) => api.create(payload));
    ipc.handle('automations:update', (_event, payload) => api.update(payload));
    ipc.handle('automations:runs:list', (_event, payload) => api.listRuns(payload));
    ipc.handle('automations:runs:get', (_event, payload) => api.getRun(payload));
    ipc.handle('automations:run-now', (_event, payload) => api.runNow(payload));
    ipc.handle('automations:runs:retry', (_event, payload) => api.retryRun(payload));
    ipc.handle('automations:runs:cancel', (_event, payload) => api.cancelRun(payload));
    ipc.handle('automations:runtime:set-paused', (_event, payload) => api.setRuntimePaused(payload));
    ipc.handle('automations:proposal:act', (_event, payload) => api.actOnProposal(payload));
  })]);
}

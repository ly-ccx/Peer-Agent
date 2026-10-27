const { contextBridge, ipcRenderer: electronIpcRenderer } = require('electron');
const overrides = new Map(/* generated from electron/ipc/channels.mjs */ []);
const ipcRenderer = {
  invoke: (key, ...args) => electronIpcRenderer.invoke(overrides.get(key) ?? key, ...args),
  sendSync: (key, ...args) => electronIpcRenderer.sendSync(overrides.get(key) ?? key, ...args),
  on: (key, handler) => electronIpcRenderer.on(overrides.get(key) ?? key, handler),
  removeListener: (key, handler) => electronIpcRenderer.removeListener(overrides.get(key) ?? key, handler),
};
const presentation = (() => {
  if (!globalThis.location?.href || globalThis.location.href === 'about:blank') return {};
  try {
    const value = ipcRenderer.sendSync('resource-window:appearance');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
})();
// No main-window API, filesystem transport, settings snapshot, task control or browser guest.
contextBridge.exposeInMainWorld('peerResource', Object.freeze({
  resourceEdits: Object.freeze({
    onChanged: listener => {
      const handler = (_event, notice) => listener(notice);
      ipcRenderer.on('resource-edit:changed', handler);
      return () => ipcRenderer.removeListener('resource-edit:changed', handler);
    },
    open: request => ipcRenderer.invoke('resource-edit:open', request),
    resume: request => ipcRenderer.invoke('resource-edit:resume', request),
    cancelOpen: requestId => ipcRenderer.invoke('resource-edit:cancel-open', requestId),
    read: handle => ipcRenderer.invoke('resource-edit:read', handle),
    acquire: request => ipcRenderer.invoke('resource-edit:acquire', request),
    save: request => ipcRenderer.invoke('resource-edit:save', request),
    discard: request => ipcRenderer.invoke('resource-edit:discard', request),
    close: handle => ipcRenderer.invoke('resource-edit:close', handle),
    list: request => ipcRenderer.invoke('resource-edit:list', request),
    history: request => ipcRenderer.invoke('resource-edit:history', request),
    readSnapshot: request => ipcRenderer.invoke('resource-edit:snapshot', request),
    cleanup: request => ipcRenderer.invoke('resource-edit:cleanup', request),
    archive: request => ipcRenderer.invoke('resource-edit:archive', request),
    clearDelivery: request => ipcRenderer.invoke('resource-edit:clear-delivery', request),
    submit: request => ipcRenderer.invoke('resource-edit:submit', request),
    continueSubmission: request => ipcRenderer.invoke('resource-edit:continue-submission', request),
    operationStatus: request => ipcRenderer.invoke('resource-edit:operation-status', request),
    reconcileSubmission: request => ipcRenderer.invoke('resource-edit:reconcile-submission', request),
    cancelSubmission: request => ipcRenderer.invoke('resource-edit:cancel-submission', request),
    decideSubmissionPermission: request => ipcRenderer.invoke('resource-edit:decide-submission-permission', request),
    readExecution: request => ipcRenderer.invoke('resource-edit:execution', request),
    readSubmission: request => ipcRenderer.invoke('resource-edit:submission', request),
  }),
  initialAppearance: presentation.appearance ?? {},
  initialLocale: typeof presentation.locale === 'string' ? presentation.locale : '',
  onAppearanceChanged: listener => {
    const handler = (_event, appearance) => listener(appearance);
    ipcRenderer.on('appearance:changed', handler);
    return () => ipcRenderer.removeListener('appearance:changed', handler);
  },
  prepareFeedback: request => ipcRenderer.invoke('resource-window:feedback', request),
  bootstrap: () => ipcRenderer.invoke('resource-window:bootstrap'),
  ready: identity => ipcRenderer.invoke('resource-window:ready', identity),
  read: request => ipcRenderer.invoke('resource-window:read', request),
  navigation: request => ipcRenderer.invoke('resource-window:navigation', request),
  acknowledgeCheckpoint: request => ipcRenderer.invoke('resource-window:checkpoint-ack', request),
  onCheckpointRequest: listener => {
    const handler = (_event, request) => listener(request);
    ipcRenderer.on('resource-window:checkpoint-request', handler);
    return () => ipcRenderer.removeListener('resource-window:checkpoint-request', handler);
  },
  onCloseBlocked: listener => {
    const handler = (_event, notice) => listener(notice);
    ipcRenderer.on('resource-window:close-blocked', handler);
    return () => ipcRenderer.removeListener('resource-window:close-blocked', handler);
  },
  returnToSource: identity => ipcRenderer.invoke('resource-window:return', identity),
  close: identity => ipcRenderer.invoke('resource-window:close', identity),
}));

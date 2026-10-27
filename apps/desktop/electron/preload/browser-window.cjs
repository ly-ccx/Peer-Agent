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
    const value = ipcRenderer.sendSync('browser-window:appearance');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
})();
// Native chrome only; no remote-page bridge, files, task control or generic guest methods.
contextBridge.exposeInMainWorld('peerBrowserWindow', Object.freeze({
  initialAppearance: presentation.appearance ?? {},
  initialLocale: typeof presentation.locale === 'string' ? presentation.locale : '',
  onAppearanceChanged: listener => {
    const handler = (_event, appearance) => listener(appearance);
    ipcRenderer.on('appearance:changed', handler);
    return () => ipcRenderer.removeListener('appearance:changed', handler);
  },
  bootstrap: () => ipcRenderer.invoke('browser-window:bootstrap'),
  action: request => ipcRenderer.invoke('browser-window:action', request),
  viewport: request => ipcRenderer.invoke('browser-window:viewport', request),
  onFeedbackNotice: listener => {
    const handler = (_event, notice) => listener(notice);
    ipcRenderer.on('resource-feedback:notice', handler);
    return () => ipcRenderer.removeListener('resource-feedback:notice', handler);
  },
  onState: listener => {
    const handler = (_event, state) => listener(state);
    ipcRenderer.on('browser-window:state', handler);
    return () => ipcRenderer.removeListener('browser-window:state', handler);
  },
}));

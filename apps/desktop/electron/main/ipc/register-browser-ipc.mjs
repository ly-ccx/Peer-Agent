function assertFunction(value, label) {
  if (typeof value !== 'function') throw new TypeError(`${label} must be a function`);
  return value;
}

function owner(ownerName, register) {
  return Object.freeze({ owner: ownerName, register });
}

export function createBrowserIpcRegistrations({ browser, sessionImport, fdaDrag, panelReveal } = {}) {
  const ports = {
    registerWebContents: assertFunction(
      browser?.registerWebContents,
      'browser.registerWebContents',
    ),
    unregisterWebContents: assertFunction(
      browser?.unregisterWebContents,
      'browser.unregisterWebContents',
    ),
    clearSiteData: assertFunction(browser?.clearSiteData, 'browser.clearSiteData'),
    capturePage: assertFunction(browser?.capturePage, 'browser.capturePage'),
    openExternal: assertFunction(browser?.openExternal, 'browser.openExternal'),
    listSessionSources: assertFunction(
      sessionImport?.listSessionSources,
      'sessionImport.listSessionSources',
    ),
    getSessionImportPreflight: assertFunction(
      sessionImport?.getPreflight,
      'sessionImport.getPreflight',
    ),
    listSessionSites: assertFunction(
      sessionImport?.listSessionSites,
      'sessionImport.listSessionSites',
    ),
    importSiteSession: assertFunction(
      sessionImport?.importSiteSession,
      'sessionImport.importSiteSession',
    ),
    openFullDiskAccessSettings: assertFunction(
      fdaDrag?.openFullDiskAccessSettings,
      'fdaDrag.openFullDiskAccessSettings',
    ),
    hideDragFloat: assertFunction(fdaDrag?.hideDragFloat, 'fdaDrag.hideDragFloat'),
    setDragFloatDragging: assertFunction(
      fdaDrag?.setDragFloatDragging,
      'fdaDrag.setDragFloatDragging',
    ),
    hideDragFloatSync: assertFunction(
      fdaDrag?.hideDragFloatSync,
      'fdaDrag.hideDragFloatSync',
    ),
    startAppDrag: assertFunction(fdaDrag?.startAppDrag, 'fdaDrag.startAppDrag'),
    getAppDragTarget: assertFunction(fdaDrag?.getAppDragTarget, 'fdaDrag.getAppDragTarget'),
    acknowledgePanelReveal: assertFunction(
      panelReveal?.acknowledge,
      'panelReveal.acknowledge',
    ),
  };

  return [
    owner('browser-ipc', (ipc) => {
      ipc.handle('browser:register-webcontents', (_event, registration = {}) =>
        ports.registerWebContents(registration));
      ipc.handle('browser:unregister-webcontents', (_event, registration = {}) =>
        ports.unregisterWebContents(registration));
      ipc.handle('browser:clear-site-data', (_event, payload = {}) =>
        ports.clearSiteData(payload));
      ipc.handle('browser:capture-page', (event, payload = {}) =>
        ports.capturePage({ ...payload, sender: event.sender }));
      ipc.handle('browser:open-external', (_event, payload = {}) =>
        ports.openExternal(payload));
      ipc.handle('browser:list-session-sources', () => ports.listSessionSources());
      ipc.handle('browser:session-import-preflight', () =>
        ports.getSessionImportPreflight());
      ipc.handle('browser:list-session-sites', (_event, payload = {}) =>
        ports.listSessionSites(payload));
      ipc.handle('browser:import-site-session', (_event, payload = {}) =>
        ports.importSiteSession(payload));
      ipc.handle('browser:open-full-disk-access-settings', (_event, payload = {}) =>
        ports.openFullDiskAccessSettings(payload));
      ipc.handle('browser:hide-fda-drag-float', () => ports.hideDragFloat());
      ipc.on('browser:fda-drag-float-dragging', (_event, payload = {}) => {
        ports.setDragFloatDragging(payload);
      });
      ipc.on('browser:hide-fda-drag-float-sync', (event) => {
        event.returnValue = ports.hideDragFloatSync();
      });
      ipc.on('browser:start-app-drag', (event, payload = {}) => {
        event.returnValue = ports.startAppDrag(payload, event.sender);
      });
      ipc.handle('browser:get-app-drag-target', () => ports.getAppDragTarget());
      ipc.handle('browser:panel-reveal-ack', (_event, payload = {}) =>
        ports.acknowledgePanelReveal(payload));
    }),
  ];
}

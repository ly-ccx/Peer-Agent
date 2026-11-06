const owner = (owner, register) => ({ owner, register });
export function createBrowserWindowIpcRegistrations({ browserWindows }) {
  return [owner('browser-window-ipc', (ipc) => {
    ipc.handle('browser-window:copy', (event, request) => browserWindows.copy(event.sender, request));
    ipc.handle('browser-window:bootstrap', event => browserWindows.bootstrap(event.sender));
    ipc.handle('browser-window:action', (event, request) => browserWindows.action(event.sender, request));
    ipc.handle('browser-window:viewport', (event, request) => browserWindows.viewport(event.sender, request));
    ipc.handle('browser-window:return-ack', (event, request) => browserWindows.acknowledgeReturn(event.sender, request));
    ipc.on('browser-window:appearance', event => { event.returnValue = browserWindows.appearance(event.sender); });
    return () => browserWindows.dispose();
  })];
}

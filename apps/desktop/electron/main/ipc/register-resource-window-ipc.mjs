function owner(owner, register) { return Object.freeze({ owner, register }); }
export function createResourceWindowIpcRegistrations({ resourceWindows }) {
  return [owner('resource-window-ipc', (ipc) => {
    ipc.handle('resource-window:feedback', (event, request) => resourceWindows.prepareFeedback(event.sender, request));
    ipc.handle('resource-window:open', (event, request) => resourceWindows.open(event.sender, request));
    ipc.handle('resource-window:history', (event, request) => resourceWindows.history(event.sender, request));
    ipc.handle('resource-window:restore', (event, request) => resourceWindows.restore(event.sender, request));
    ipc.handle('resource-window:forget', (event, request) => resourceWindows.forget(event.sender, request));
    ipc.handle('resource-window:return-ack', (event, request) => resourceWindows.acknowledgeReturn(event.sender, request));
    ipc.handle('resource-window:checkpoint-ack', (event, request) => resourceWindows.acknowledgeCheckpoint(event.sender, request));
    ipc.handle('resource-window:bootstrap', event => resourceWindows.bootstrap(event.sender));
    ipc.handle('resource-window:ready', (event, identity) => resourceWindows.ready(event.sender, identity));
    ipc.handle('resource-window:read', (event, request) => resourceWindows.read(event.sender, request));
    ipc.handle('resource-window:navigation', (event, request) => resourceWindows.navigation(event.sender, request));
    ipc.handle('resource-window:return', (event, identity) => resourceWindows.returnToSource(event.sender, identity));
    ipc.handle('resource-window:close', (event, identity) => resourceWindows.close(event.sender, identity));
    ipc.on('resource-window:appearance', event => { event.returnValue = resourceWindows.appearance(event.sender); });
    return () => resourceWindows.dispose();
  })];
}

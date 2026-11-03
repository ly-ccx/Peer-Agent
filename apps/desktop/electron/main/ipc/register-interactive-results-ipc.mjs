function owner(owner, register) { return Object.freeze({ owner, register }); }
export function createInteractiveResultsIpcRegistrations({ interactiveResults }) {
  return [owner('interactive-results-ipc', (ipc) => {
    ipc.handle('interactive-results:open', (event, request) => interactiveResults.open(event.sender, request));
    ipc.handle('interactive-results:cancel-open', (event, request) => interactiveResults.cancelOpen(event.sender, request));
    ipc.handle('interactive-results:read-state', (event, request) => interactiveResults.readState(event.sender, request));
    ipc.handle('interactive-results:acquire', (event, request) => interactiveResults.acquire(event.sender, request));
    ipc.handle('interactive-results:save', (event, request) => interactiveResults.save(event.sender, request));
    ipc.handle('interactive-results:release', (event, request) => interactiveResults.release(event.sender, request));
    ipc.handle('interactive-results:prepare-followup', (event, request) => interactiveResults.prepareFollowup(event.sender, request));
    return () => interactiveResults.dispose();
  }), owner('resource-presentation-ipc', (ipc) => {
    ipc.handle('resource-presentation:read-layout', (event, request) => interactiveResults.readLayout(event.sender, request));
    ipc.handle('resource-presentation:write-layout', (event, request) => interactiveResults.writeLayout(event.sender, request));
  })];
}

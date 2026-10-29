const owner = (owner, register) => ({ owner, register });
export function createResourceEditIpcRegistrations({ edits, submissions }) {
  return [owner('resource-edit-ipc', (ipc) => {
    ipc.handle('resource-edit:open', (event, request) => edits.open(event.sender, request));
    ipc.handle('resource-edit:resume', (event, request) => edits.resume(event.sender, request));
    ipc.handle('resource-edit:cancel-open', (event, requestId) => edits.cancelOpen(event.sender, requestId));
    ipc.handle('resource-edit:read', (event, handle) => edits.read(event.sender, handle));
    ipc.handle('resource-edit:acquire', (event, request) => edits.acquire(event.sender, request));
    ipc.handle('resource-edit:save', (event, request) => edits.save(event.sender, request));
    ipc.handle('resource-edit:discard', (event, request) => edits.discard(event.sender, request));
    ipc.handle('resource-edit:close', (event, handle) => edits.close(event.sender, handle));
    ipc.handle('resource-edit:list', (event, request) => edits.list(event.sender, request));
    ipc.handle('resource-edit:history', (event, request) => edits.history(event.sender, request));
    ipc.handle('resource-edit:snapshot', (event, request) => edits.readSnapshot(event.sender, request));
    ipc.handle('resource-edit:cleanup', (event, request) => edits.cleanup(event.sender, request));
    ipc.handle('resource-edit:archive', (event, request) => edits.archive(event.sender, request));
    ipc.handle('resource-edit:clear-delivery', (event, request) => edits.clearDelivery(event.sender, request));
    ipc.handle('resource-edit:submit', (event, request) => submissions.submit(event.sender, request));
    ipc.handle('resource-edit:continue-submission', (event, request) => submissions.continueSubmission(event.sender, request));
    ipc.handle('resource-edit:operation-status', (event, request) => submissions.operationStatus(event.sender, request));
    ipc.handle('resource-edit:reconcile-submission', (event, request) => submissions.reconcileSubmission(event.sender, request));
    ipc.handle('resource-edit:cancel-submission', (event, request) => submissions.cancelSubmission(event.sender, request));
    ipc.handle('resource-edit:decide-submission-permission', (event, request) => submissions.decideSubmissionPermission(event.sender, request));
    ipc.handle('resource-edit:execution', (event, request) => submissions.readExecution(event.sender, request));
    ipc.handle('resource-edit:submission', (event, request) => submissions.readSubmission(event.sender, request));
    return () => edits.dispose();
  })];
}

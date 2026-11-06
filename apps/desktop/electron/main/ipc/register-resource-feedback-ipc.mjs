const owner = (owner, register) => ({ owner, register });
export function createResourceFeedbackIpcRegistrations({ preparation }) {
  return [owner('resource-feedback-ipc', (ipc) => {
    ipc.handle('resource-feedback:claim', (event, request) => preparation.claim(event.sender, request));
    ipc.handle('resource-feedback:ack', (event, request) => preparation.acknowledge(event.sender, request));
    return () => preparation.dispose();
  })];
}

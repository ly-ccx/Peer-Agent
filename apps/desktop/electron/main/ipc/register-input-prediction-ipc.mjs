const owner = (owner, register) => ({ owner, register });
export function createInputPredictionIpcRegistrations({ prediction }) {
  return [owner('input-prediction-ipc', (ipc) => {
    ipc.handle('input-prediction:request', (event, payload) => prediction.request(payload, event.sender));
    ipc.handle('input-prediction:cancel', (event, payload) => prediction.cancel(payload, event.sender));
    ipc.handle('input-prediction:validate', (event, payload) => prediction.validate(payload, event.sender));
    ipc.handle('input-prediction:status', event => prediction.status(event.sender));
    return () => prediction.dispose();
  })];
}

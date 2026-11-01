import { Worker } from 'node:worker_threads';

/** Keep synchronous OS credential helpers away from the interactive main loop. */
export function createPredictionCredentialResolver({ configFile, dataHome }) {
  return (provider, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('CANCELLED')); return; }
    const worker = new Worker(new URL('./credential-worker.mjs', import.meta.url), {
      workerData: { provider, configFile, dataHome },
    });
    let finished = false;
    const finish = (error, value) => {
      if (finished) return;
      finished = true; signal?.removeEventListener('abort', abort);
      void worker.terminate();
      if (error) reject(new Error(error)); else resolve(value);
    };
    const abort = () => finish('CANCELLED');
    signal?.addEventListener('abort', abort, { once: true });
    worker.once('message', message => finish(message.ok ? null : `CREDENTIAL_UNAVAILABLE:${message.code}`, message.value));
    worker.once('error', () => finish('CREDENTIAL_UNAVAILABLE'));
    worker.once('exit', () => { if (!finished) finish('CREDENTIAL_UNAVAILABLE'); });
  });
}

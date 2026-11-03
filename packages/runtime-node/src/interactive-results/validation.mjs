import { Worker } from 'node:worker_threads';
import { INTERACTIVE_RESULT_LIMITS as L } from '@peer-agent/protocol';

const failure = code => Object.assign(Error(code), { code });

/** Each hostile program has its own terminable, bounded evaluation lifetime. */
export async function runInteractiveValidation(input, { signal, timeoutMs = L.workerTimeoutMs, WorkerImpl = Worker } = {}) {
  if (signal?.aborted) throw failure('interactive_cancelled');
  if (!input || !['validate', 'evaluate'].includes(input.operation) || Buffer.byteLength(JSON.stringify(input)) > 2 * 1024 * 1024) throw failure('interactive_resource_limit');
  const worker = new WorkerImpl(new URL('./validation-worker.mjs', import.meta.url), {
    workerData: input,
    env: { NODE_ENV: 'production', OPENUI_TELEMETRY_DISABLED: '1', OPENUI_RUNTIME_TELEMETRY_ENABLED: '0', TZ: 'UTC' },
    resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 2 },
  });
  try {
    return await new Promise((resolve, reject) => {
      let finished = false;
      const finish = (error, value) => {
        if (finished) return;
        finished = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
        worker.removeAllListeners();
        if (error) reject(error); else resolve(value);
      };
      const abort = () => finish(failure('interactive_cancelled'));
      const timer = setTimeout(() => finish(failure('interactive_validation_timeout')), Math.max(1, Math.min(L.workerTimeoutMs, timeoutMs)));
      signal?.addEventListener('abort', abort, { once: true });
      worker.once('message', message => message?.ok ? finish(null, message.result)
        : finish(Object.assign(failure(message?.code ?? 'interactive_validation_failed'), { path: message?.path ?? '', details: message?.details ?? '' })));
      worker.once('error', () => finish(failure('interactive_worker_failed')));
      worker.once('exit', () => finish(failure('interactive_worker_exited')));
      if (signal?.aborted) abort();
    });
  } finally { await worker.terminate(); }
}

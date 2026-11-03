import { parentPort, workerData } from 'node:worker_threads';
import { evaluate, projectText, validateDraft } from '@peer-agent/interactive-content';

// No data transport is part of the content evaluator, including opted-in SDK telemetry.
globalThis.fetch = () => { throw Object.assign(Error('interactive_network_forbidden'), { code: 'interactive_network_forbidden' }); };

try {
  let result;
  if (workerData.operation === 'validate') result = await validateDraft(workerData.draft, { bindings: workerData.bindings, expectedSpecHash: workerData.expectedSpecHash });
  else if (workerData.operation === 'evaluate') {
    const evaluated = await evaluate(workerData.content, workerData.values);
    result = { ...evaluated, projection: projectText(evaluated.tree) };
  } else throw Object.assign(Error('invalid_validation_operation'), { code: 'invalid_validation_operation' });
  parentPort.postMessage({ ok: true, result });
} catch (error) {
  parentPort.postMessage({ ok: false, code: error?.code ?? 'interactive_validation_failed', path: String(error?.path ?? '').slice(0, 240), details: String(error?.details ?? '').slice(0, 240) });
}

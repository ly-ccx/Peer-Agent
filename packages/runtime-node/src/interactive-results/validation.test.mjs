import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Worker } from 'node:worker_threads';
import test from 'node:test';
import { runInteractiveValidation } from './validation.mjs';

const draft = { title: 'Trial', textFallback: 'Model explanation.', program: '$x=2\nroot=Col([Metric("x",$x*3)])' };
test('real isolated worker validates and evaluates fixed content with telemetry disabled', async () => {
  const content = await runInteractiveValidation({ operation: 'validate', draft, bindings: {} });
  assert.equal(content.tree.props.children[0].props.value, 6);
  const direct = await import('@peer-agent/interactive-content');
  assert.equal(content.specHash, await direct.catalogIdentity());
  const evaluated = await runInteractiveValidation({ operation: 'evaluate', content, values: { $x: 3 } });
  assert.equal(evaluated.tree.props.children[0].props.value, 9);
  assert.match(evaluated.projection.text, /x: 9/);
  assert.deepEqual(evaluated.tree, (await direct.evaluate(content, { $x: 3 })).tree, 'bundled Worker and direct renderer adapter use identical public semantics');
});
test('real worker rejects dangerous AST before evaluation and reports bounded diagnostics', async () => {
  await assert.rejects(runInteractiveValidation({ operation: 'validate', draft: { ...draft, program: 'root=Col([HtmlView("<script>fetch()</script>")])' }, bindings: {} }), { code: 'unsupported_node' });
});

test('the packaged Worker enforces protected initial, evaluation and condition-description state without echo', async () => {
  const program = '$note="Trial"\nroot=Input("note","Note",$note)';
  const content = await runInteractiveValidation({ operation: 'validate', draft: { ...draft, program }, bindings: {} });
  const protectedValue = 'sk-examplecredential012345678901234567890';
  for (const operation of ['evaluate', 'describe-state']) {
    await assert.rejects(runInteractiveValidation({ operation, content, values: { $note: protectedValue }, fields: ['$note'] }),
      error => error.code === 'interactive_state_protected' && error.path === '' && error.details === '' && !error.message.includes(protectedValue));
  }
  await assert.rejects(runInteractiveValidation({ operation: 'validate', draft: { ...draft,
    program: `$note=${JSON.stringify(protectedValue)}\nroot=Input("note","Note",$note)` }, bindings: {} }), { code: 'interactive_state_protected' });
});
test('the isolated worker reconstructs condition labels from the published program, including a currently invalid calculation', async () => {
  const content = await runInteractiveValidation({ operation: 'validate', draft: { ...draft,
    program: '$x=2\n$name="Original label"\nroot=Col([NumberInput("x",$name,$x,0,10,1),Input("name","Trial name",$name),Metric("Ratio",10/$x)])' }, bindings: {} });
  const values = { $x: 0, $name: 'Changed label' };
  await assert.rejects(runInteractiveValidation({ operation: 'evaluate', content, values }), { code: 'division_by_zero' });
  delete content.tree;
  const described = await runInteractiveValidation({ operation: 'describe-state', content, values, fields: ['$x', '$name'] });
  assert.deepEqual(described, { text: 'Original label: 0\nTrial name: Changed label', specHash: content.specHash, stateSchemaHash: content.stateSchemaHash });
  await assert.rejects(runInteractiveValidation({ operation: 'describe-state', content: { ...content, specHash: 'sha256:forged' }, values, fields: ['$x'] }),
    { code: 'incompatible_catalog' });
});
test('timeout and cancellation terminate the exact worker instead of leaving background evaluation', async () => {
  const workers = [];
  let onStarted;
  class PendingWorker extends EventEmitter {
    constructor(_source, options) { super(); this.options = options; workers.push(this); onStarted?.(this); }
    async terminate() { this.terminated = true; }
  }
  await assert.rejects(runInteractiveValidation({ operation: 'validate', draft }, { WorkerImpl: PendingWorker, timeoutMs: 5 }), { code: 'interactive_validation_timeout' });
  assert.equal(workers[0].terminated, true);
  assert.equal(workers[0].options.env.OPENUI_TELEMETRY_DISABLED, '1');
  assert.equal(workers[0].options.resourceLimits.maxOldGenerationSizeMb, 64);
  assert.equal(workers[0].options.eval, true, 'the worker does not depend on a source file beside a compiled CLI');
  const controller = new AbortController();
  const started = new Promise(resolve => { onStarted = resolve; });
  const pending = runInteractiveValidation({ operation: 'validate', draft }, { WorkerImpl: PendingWorker, signal: controller.signal });
  await started;
  controller.abort();
  await assert.rejects(pending, { code: 'interactive_cancelled' });
  assert.equal(workers[1].terminated, true);
  const early = new AbortController();
  const beforeLoading = runInteractiveValidation({ operation: 'validate', draft }, { WorkerImpl: PendingWorker, signal: early.signal });
  early.abort();
  await assert.rejects(beforeLoading, { code: 'interactive_cancelled' });
  assert.equal(workers.length, 2, 'cancellation while loading the bundle never starts another worker');
});

test('cancelling a created real worker waits for its actual termination', async () => {
  let instance, notifyStart, notifyExit;
  const started = new Promise(resolve => { notifyStart = resolve; });
  const exited = new Promise(resolve => { notifyExit = resolve; });
  class TrackedWorker extends Worker {
    constructor(source, options) { super(source, options); instance = this; this.once('exit', notifyExit); notifyStart(); }
    async terminate() { const code = await super.terminate(); this.stopped = true; return code; }
  }
  const controller = new AbortController();
  const pending = runInteractiveValidation({ operation: 'validate', draft }, { WorkerImpl: TrackedWorker, signal: controller.signal });
  await started; controller.abort();
  await assert.rejects(pending, { code: 'interactive_cancelled' });
  assert.equal(instance.stopped, true); assert.equal(typeof await exited, 'number');
});

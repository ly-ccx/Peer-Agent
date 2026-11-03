import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { runInteractiveValidation } from './validation.mjs';

const draft = { title: 'Trial', textFallback: 'Model explanation.', program: '$x=2\nroot=Col([Metric("x",$x*3)])' };
test('real isolated worker validates and evaluates fixed content with telemetry disabled', async () => {
  const content = await runInteractiveValidation({ operation: 'validate', draft, bindings: {} });
  assert.equal(content.tree.props.children[0].props.value, 6);
  const evaluated = await runInteractiveValidation({ operation: 'evaluate', content, values: { $x: 3 } });
  assert.equal(evaluated.tree.props.children[0].props.value, 9);
  assert.match(evaluated.projection.text, /x: 9/);
});
test('real worker rejects dangerous AST before evaluation and reports bounded diagnostics', async () => {
  await assert.rejects(runInteractiveValidation({ operation: 'validate', draft: { ...draft, program: 'root=Col([HtmlView("<script>fetch()</script>")])' }, bindings: {} }), { code: 'unsupported_node' });
});
test('timeout and cancellation terminate the exact worker instead of leaving background evaluation', async () => {
  const workers = [];
  class PendingWorker extends EventEmitter {
    constructor(_url, options) { super(); this.options = options; workers.push(this); }
    async terminate() { this.terminated = true; }
  }
  await assert.rejects(runInteractiveValidation({ operation: 'validate', draft }, { WorkerImpl: PendingWorker, timeoutMs: 5 }), { code: 'interactive_validation_timeout' });
  assert.equal(workers[0].terminated, true);
  assert.equal(workers[0].options.env.OPENUI_TELEMETRY_DISABLED, '1');
  assert.equal(workers[0].options.resourceLimits.maxOldGenerationSizeMb, 64);
  const controller = new AbortController();
  const pending = runInteractiveValidation({ operation: 'validate', draft }, { WorkerImpl: PendingWorker, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { code: 'interactive_cancelled' });
  assert.equal(workers[1].terminated, true);
});

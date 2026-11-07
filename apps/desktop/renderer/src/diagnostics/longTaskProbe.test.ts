import assert from 'node:assert/strict';
import test from 'node:test';
import { formatRendererLongTask, observeRendererLongTasks } from './longTaskProbe.ts';

test('renderer long task line keeps attribution names and drops unrelated body text', () => {
  const secret = 'super-secret-plan-body';
  const line = formatRendererLongTask({
    duration: 87.6,
    name: 'self',
    attribution: [{ containerName: 'iframe', name: 'app.js' }],
  });
  assert.equal(line, '[renderer-longtask] ms=88 name=self via=iframe:app.js');
  const leaked = formatRendererLongTask({
    duration: 50,
    name: 'self',
    attribution: [{ name: `https://cdn.example/app.js?token=${secret}` }],
  });
  assert.equal(leaked.includes(secret), false);
  assert.match(leaked, /via=app\.js$/);
  const unrelated = { duration: 40, name: 'self', body: secret };
  assert.equal(formatRendererLongTask(unrelated).includes(secret), false);
});

test('long task names are truncated', () => {
  const line = formatRendererLongTask({ duration: 10, name: 'n'.repeat(400) });
  assert.ok(line.length < 200);
  assert.match(line, /name=n{120}/);
});

test('observeRendererLongTasks reports formatted entries and ignores unsupported observers', () => {
  const lines: string[] = [];
  let observed = false;
  class FakeObserver {
    callback: (list: { getEntries(): unknown[] }) => void;
    constructor(callback: (list: { getEntries(): unknown[] }) => void) { this.callback = callback; }
    observe() { observed = true; }
    disconnect() {}
    emit() { this.callback({ getEntries: () => [{ duration: 60, name: 'self' }] }); }
  }
  const observer = observeRendererLongTasks(FakeObserver as unknown as typeof PerformanceObserver, (line) => lines.push(line));
  assert.equal(observed, true);
  (observer as unknown as { emit(): void }).emit();
  assert.deepEqual(lines, ['[renderer-longtask] ms=60 name=self']);
  assert.equal(typeof observeRendererLongTasks(undefined as unknown as typeof PerformanceObserver).disconnect, 'function');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { hasSidebarInterruption, sidebarInterruptedState } from './sidebarInterruptedState.ts';

// Selection is deliberately not an input: background and current rows use the same facts.
for (const selected of [true, false]) {
  for (const source of ['live', 'history']) {
    for (const phase of ['interrupted', 'continuing', 'completed']) {
      test(`${selected ? 'current' : 'background'} / ${source} / ${phase}`, () => {
        const messages = [{ role: 'assistant', interrupted: phase !== 'completed' }];
        const state = {
          loadStatus: source === 'live' ? 'ready' : 'idle',
          messages: source === 'live' ? messages : [],
          isStreaming: phase === 'continuing',
        };
        assert.equal(sidebarInterruptedState(state, hasSidebarInterruption(messages), false), phase === 'interrupted');
      });
    }
  }
}

test('live completion overrides stale interrupted history', () => {
  assert.equal(sidebarInterruptedState({ loadStatus: 'ready', messages: [{ role: 'assistant' }], isStreaming: false }, true, false), false);
});
test('empty loaded conversation overrides history', () => {
  assert.equal(sidebarInterruptedState({ loadStatus: 'ready', messages: [], isStreaming: false }, true, false), false);
});
test('main process running state hides interruption before renderer reattach', () => {
  assert.equal(sidebarInterruptedState({ loadStatus: 'idle', messages: [], isStreaming: false }, true, true), false);
});
test('old interruption cannot survive a new turn', () => {
  assert.equal(hasSidebarInterruption([{ role: 'assistant', interrupted: true }, { role: 'user' }]), false);
  assert.equal(hasSidebarInterruption([{ role: 'assistant', interrupted: true }, { role: 'assistant' }]), false);
});
test('unknown or non-assistant history is not an interruption', () => {
  assert.equal(hasSidebarInterruption([]), false);
  assert.equal(hasSidebarInterruption([{ role: 'user', interrupted: true }]), false);
});

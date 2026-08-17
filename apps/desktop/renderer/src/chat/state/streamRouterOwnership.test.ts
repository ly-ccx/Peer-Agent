import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  dispatchBrowserToolReveal,
  registerBrowserToolReveal,
  resetBrowserToolRevealHandlersForTests,
} from './streamRouterOwnership.ts';

describe('stream router browser reveal ownership', () => {
  it('dispatches only to the conversation that registered the handler', () => {
    resetBrowserToolRevealHandlersForTests();
    const seen: string[] = [];
    const unregister = registerBrowserToolReveal('conv-a', (tool) => {
      seen.push(`a:${tool}`);
    });
    registerBrowserToolReveal('conv-b', (tool) => {
      seen.push(`b:${tool}`);
    });

    dispatchBrowserToolReveal('conv-a', 'browser_navigate');
    dispatchBrowserToolReveal('conv-b', 'browser_click');
    dispatchBrowserToolReveal('conv-c', 'browser_type');
    dispatchBrowserToolReveal(null, 'browser_screenshot');

    assert.deepEqual(seen, ['a:browser_navigate', 'b:browser_click']);
    unregister();
    dispatchBrowserToolReveal('conv-a', 'browser_type');
    assert.deepEqual(seen, ['a:browser_navigate', 'b:browser_click']);
    resetBrowserToolRevealHandlersForTests();
  });
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldRevealBrowserPanel } from './browserToolReveal.ts';

test('reveals Browser for every built-in browser tool in the active conversation', () => {
  for (const tool of [
    'browser_navigate',
    'browser_click',
    'browser_type',
    'browser_screenshot',
    'browser_read_dom',
  ]) {
    assert.equal(shouldRevealBrowserPanel(tool, 'conversation-a', 'conversation-a'), true, tool);
  }
});

test('does not steal focus for background conversations or unrelated tools', () => {
  assert.equal(shouldRevealBrowserPanel('browser_navigate', 'conversation-b', 'conversation-a'), false);
  assert.equal(shouldRevealBrowserPanel('goal_create_plan', 'conversation-a', 'conversation-a'), false);
  assert.equal(shouldRevealBrowserPanel('browser_navigate', 'conversation-a', null), false);
});

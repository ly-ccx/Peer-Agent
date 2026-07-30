import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createBrowserSessionState,
  createBrowserTabSession,
  isBlankBrowserSession,
} from './browserSessionState.ts';

test('blank about:blank browser session is detected', () => {
  assert.equal(isBlankBrowserSession(createBrowserSessionState()), true);
  assert.equal(
    isBlankBrowserSession(createBrowserSessionState(createBrowserTabSession('https://example.com', 'Example'))),
    false,
  );
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getBrowserSessionUrl,
  resetBrowserSessionUrlsForTests,
  setBrowserSessionUrl,
} from './browserSessionState.ts';

test('keeps and restores independent browser URLs for each conversation', () => {
  resetBrowserSessionUrlsForTests();

  setBrowserSessionUrl('conversation-a', 'https://example.com/a');
  setBrowserSessionUrl('conversation-b', 'https://example.com/b');

  assert.equal(getBrowserSessionUrl('conversation-a'), 'https://example.com/a');
  assert.equal(getBrowserSessionUrl('conversation-b'), 'https://example.com/b');
  assert.equal(getBrowserSessionUrl('conversation-a'), 'https://example.com/a');
});

test('starts new conversations at a blank page', () => {
  resetBrowserSessionUrlsForTests();
  assert.equal(getBrowserSessionUrl('new-conversation'), 'about:blank');
});

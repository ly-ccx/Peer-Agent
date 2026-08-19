import assert from 'node:assert/strict';
import test from 'node:test';
import {
  rememberPreparedBrowser,
  resolveBrowserPanelReveal,
} from './browserPanelReveal.ts';

test('foreground focus still opens the current conversation Browser panel', () => {
  const decision = resolveBrowserPanelReveal({
    requestConversationId: 'conversation-a',
    hostConversationId: 'conversation-a',
    layoutHost: 'root',
    focus: true,
    hostOpen: false,
    hostBrowserActive: false,
    requestSessionExists: false,
  });
  assert.deepEqual(decision, {
    accept: true,
    stealUi: true,
    prepareSession: true,
    mountPrepared: true,
    status: 'opened',
  });
});

test('background Task can prepare another conversation without stealing the workbench', () => {
  const decision = resolveBrowserPanelReveal({
    requestConversationId: 'conversation-b',
    hostConversationId: 'conversation-a',
    layoutHost: 'root',
    focus: true,
    hostOpen: true,
    hostBrowserActive: true,
    requestSessionExists: false,
  });
  assert.deepEqual(decision, {
    accept: true,
    stealUi: false,
    prepareSession: true,
    mountPrepared: true,
    status: 'opened',
  });
});

test('background Task does not need the user to already be on that conversation', () => {
  const decision = resolveBrowserPanelReveal({
    requestConversationId: 'conversation-b',
    hostConversationId: 'conversation-a',
    layoutHost: 'root',
    focus: false,
    hostOpen: false,
    hostBrowserActive: false,
    requestSessionExists: true,
  });
  assert.equal(decision.accept, true);
  assert.equal(decision.stealUi, false);
  assert.equal(decision.mountPrepared, true);
  assert.equal(decision.status, 'already_active');
});

test('nested drawer workbench does not consume global Browser reveal', () => {
  const decision = resolveBrowserPanelReveal({
    requestConversationId: 'conversation-a',
    hostConversationId: 'conversation-a',
    layoutHost: 'local',
    focus: true,
    hostOpen: true,
    hostBrowserActive: false,
    requestSessionExists: true,
  });
  assert.equal(decision.accept, false);
  assert.equal(decision.error, 'not_reveal_host');
});

test('rememberPreparedBrowser keeps the newest conversations within the cap', () => {
  const ids = rememberPreparedBrowser(
    ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
    'i',
  );
  assert.deepEqual(ids, ['b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']);
  assert.deepEqual(rememberPreparedBrowser(ids, 'c'), ['b', 'd', 'e', 'f', 'g', 'h', 'i', 'c']);
});

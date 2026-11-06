import assert from 'node:assert/strict';
import test from 'node:test';
import { openResourceConversation, closeResourceConversation, type ResourceConversation, type ResourceConversations } from './resourceConversationState.ts';

const scene = (id: string): ResourceConversation => ({ workspaceId: 'A', workspacePath: '/synthetic/project', conversationId: id,
  title: id, task: { sessionId: `session-${id}`, planId: `plan-${id}` } });
const empty = (): ResourceConversations => ({ owner: 'A', tabs: [], activeId: null });

test('opening the same child selects its original tab without losing other children or task identity', () => {
  const first = openResourceConversation(empty(), scene('one'));
  const second = openResourceConversation(first, scene('two'));
  const reopened = openResourceConversation(second, { ...scene('one'), title: 'Updated title' });
  assert.deepEqual(reopened.tabs.map(tab => tab.conversationId), ['one', 'two']);
  assert.equal(reopened.activeId, 'one');
  assert.equal(reopened.tabs[0]?.title, 'Updated title');
  assert.deepEqual(reopened.tabs[0]?.task, scene('one').task);
  assert.equal(reopened.tabs[1], second.tabs[1]);
});

test('closing a view selects its neighbor and leaves the original conversation descriptor untouched', () => {
  const original = scene('one');
  const state = openResourceConversation(openResourceConversation(empty(), original), scene('two'));
  const after = closeResourceConversation(state, 'two');
  assert.equal(after.activeId, 'one');
  assert.equal(after.tabs[0], original);
  assert.deepEqual(closeResourceConversation(after, 'one'), empty());
  assert.equal(closeResourceConversation(state, 'missing'), state);
});

test('a late open for another Bot cannot populate the current resource pane', () => {
  const state = empty();
  assert.equal(openResourceConversation(state, { ...scene('one'), workspaceId: 'B' }), state);
  assert.equal(openResourceConversation(state, { ...scene('one'), conversationId: '' }), state);
});

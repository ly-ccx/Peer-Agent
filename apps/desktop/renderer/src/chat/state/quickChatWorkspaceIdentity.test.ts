import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getQuickChatWorkspaceIdentity } from './quickChatWorkspaceIdentity.ts';

describe('getQuickChatWorkspaceIdentity', () => {
  it('uses the final folder as the visible workspace name', () => {
    assert.equal(getQuickChatWorkspaceIdentity('/Users/peer/projects/agent/').name, 'agent');
    assert.equal(getQuickChatWorkspaceIdentity('C:\\work\\desktop').name, 'desktop');
  });

  it('assigns a stable visual accent for the same workspace path', () => {
    const first = getQuickChatWorkspaceIdentity('/Users/peer/projects/agent');
    const second = getQuickChatWorkspaceIdentity('/Users/peer/projects/agent/');
    assert.equal(first.accentIndex, second.accentIndex);
    assert.ok(first.accentIndex >= 0 && first.accentIndex < 6);
  });
});

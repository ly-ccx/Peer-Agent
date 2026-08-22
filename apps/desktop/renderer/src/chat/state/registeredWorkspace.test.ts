import assert from 'node:assert/strict';
import test from 'node:test';
import { registeredWorkspacePath, isWorkspaceRequiredNotice, workspaceRequiredNotice } from './registeredWorkspace.ts';

const workspaces = [{ path: '/repo/peer_agent' }, { path: '/repo/other' }];

test('registeredWorkspacePath keeps only configured workspace paths', () => {
  assert.equal(registeredWorkspacePath('/repo/peer_agent', workspaces), '/repo/peer_agent');
  assert.equal(registeredWorkspacePath('/Users/me/PeerAgent', workspaces), null);
  assert.equal(registeredWorkspacePath(null, workspaces), null);
  assert.equal(registeredWorkspacePath('', workspaces), null);
  assert.equal(registeredWorkspacePath('/repo/peer_agent', []), null);
});

test('workspace required notice clears independently of other attachment errors', () => {
  assert.equal(workspaceRequiredNotice(true), '请先选择工作区。');
  assert.equal(isWorkspaceRequiredNotice('请先选择工作区。'), true);
  assert.equal(isWorkspaceRequiredNotice('Select a workspace before starting a task.'), true);
  assert.equal(isWorkspaceRequiredNotice('file too large'), false);
});

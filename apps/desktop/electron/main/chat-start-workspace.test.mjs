import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveNewTaskWorkspacePath } from './chat-start-workspace.mjs';

const workspaces = [{ path: '/repo/peer_agent' }];

test('new tasks bind only a registered workspace, never a preview default', () => {
  assert.equal(resolveNewTaskWorkspacePath({
    requested: '/repo/peer_agent',
    activeWorkspace: null,
    workspaces,
  }), '/repo/peer_agent');
  assert.equal(resolveNewTaskWorkspacePath({
    requested: null,
    activeWorkspace: '/repo/peer_agent',
    workspaces,
  }), '/repo/peer_agent');
  assert.equal(resolveNewTaskWorkspacePath({
    requested: '/Users/me/PeerAgent',
    activeWorkspace: '/Users/me/PeerAgent',
    workspaces,
  }), null);
  assert.equal(resolveNewTaskWorkspacePath({
    requested: '/Users/me/PeerAgent',
    activeWorkspace: '/repo/peer_agent',
    workspaces,
  }), '/repo/peer_agent');
  assert.equal(resolveNewTaskWorkspacePath({
    requested: '/repo/peer_agent',
    workspaces: [],
  }), null);
});

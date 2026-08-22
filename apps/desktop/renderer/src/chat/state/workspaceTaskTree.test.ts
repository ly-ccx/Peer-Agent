import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isWorkspaceTaskTreeOpen,
  nextWorkspaceTreeToggles,
  openWorkspaceTreeToggles,
} from './workspaceTaskTree.ts';

test('defaults to open only for the active or focused workspace', () => {
  const toggled = new Set<string>();
  assert.equal(
    isWorkspaceTaskTreeOpen({
      path: '/a',
      toggled,
      activeWorkspace: '/a',
      focusedWorkspace: null,
    }),
    true,
  );
  assert.equal(
    isWorkspaceTaskTreeOpen({
      path: '/b',
      toggled,
      activeWorkspace: '/a',
      focusedWorkspace: '/c',
    }),
    false,
  );
  assert.equal(
    isWorkspaceTaskTreeOpen({
      path: '/c',
      toggled,
      activeWorkspace: '/a',
      focusedWorkspace: '/c',
    }),
    true,
  );
});

test('manual toggle flips the default open state', () => {
  const toggled = nextWorkspaceTreeToggles(new Set(), '/a');
  assert.equal(
    isWorkspaceTaskTreeOpen({
      path: '/a',
      toggled,
      activeWorkspace: '/a',
      focusedWorkspace: null,
    }),
    false,
  );
  assert.equal(
    isWorkspaceTaskTreeOpen({
      path: '/b',
      toggled: nextWorkspaceTreeToggles(new Set(), '/b'),
      activeWorkspace: '/a',
      focusedWorkspace: null,
    }),
    true,
  );
});

test('activating a workspace clears its toggle so it opens again', () => {
  const collapsedActive = nextWorkspaceTreeToggles(new Set(), '/a');
  assert.equal(
    isWorkspaceTaskTreeOpen({
      path: '/a',
      toggled: openWorkspaceTreeToggles(collapsedActive, '/a'),
      activeWorkspace: '/a',
      focusedWorkspace: null,
    }),
    true,
  );
});

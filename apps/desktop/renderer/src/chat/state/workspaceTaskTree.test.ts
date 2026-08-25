import assert from 'node:assert/strict';
import test from 'node:test';
import {
  emptyWorkspaceTreeToggles,
  isWorkspaceTaskTreeOpen,
  nextWorkspaceRowClickToggles,
  nextWorkspaceTreeToggles,
  openWorkspaceTreeToggles,
  rememberOpenWorkspaceTrees,
  UNASSIGNED_WORKSPACE_KEY,
} from './workspaceTaskTree.ts';

function isOpen(
  path: string,
  toggles: ReturnType<typeof emptyWorkspaceTreeToggles>,
  activeWorkspace: string | null,
  focusedWorkspace: string | null,
): boolean {
  return isWorkspaceTaskTreeOpen({ path, toggles, activeWorkspace, focusedWorkspace });
}

test('auto-opens the active or focused workspace and leaves others closed', () => {
  const toggles = emptyWorkspaceTreeToggles();
  assert.equal(isOpen('/a', toggles, '/a', null), true);
  assert.equal(isOpen('/b', toggles, '/a', null), false);
  assert.equal(isOpen('/c', toggles, '/a', '/c'), true);
  assert.equal(isOpen('/b', toggles, '/a', '/c'), false);
});

test('selecting another workspace conversation does not collapse a previously open group', () => {
  let toggles = rememberOpenWorkspaceTrees(emptyWorkspaceTreeToggles(), ['/a']);
  // User had /a open, then clicked a session in /c.
  toggles = rememberOpenWorkspaceTrees(toggles, ['/c']);
  assert.equal(isOpen('/a', toggles, '/c', '/c'), true);
  assert.equal(isOpen('/c', toggles, '/c', '/c'), true);
  assert.equal(isOpen('/b', toggles, '/c', '/c'), false);
});

test('chevron still collapses one group without closing others', () => {
  let toggles = rememberOpenWorkspaceTrees(emptyWorkspaceTreeToggles(), ['/a', '/c']);
  assert.equal(isOpen('/a', toggles, '/c', '/c'), true);
  toggles = nextWorkspaceTreeToggles(toggles, '/a', true);
  assert.equal(isOpen('/a', toggles, '/c', '/c'), false);
  assert.equal(isOpen('/c', toggles, '/c', '/c'), true);
  toggles = nextWorkspaceTreeToggles(toggles, '/a', false);
  assert.equal(isOpen('/a', toggles, '/c', '/c'), true);
});

test('chevron can collapse the currently focused workspace', () => {
  const collapsed = nextWorkspaceTreeToggles(emptyWorkspaceTreeToggles(), '/a', true);
  assert.equal(isOpen('/a', collapsed, '/a', null), false);
});

test('remembering auto-open groups does not override a chevron collapse', () => {
  let toggles = nextWorkspaceTreeToggles(emptyWorkspaceTreeToggles(), '/a', true);
  toggles = rememberOpenWorkspaceTrees(toggles, ['/a', '/c']);
  assert.equal(isOpen('/a', toggles, '/c', '/c'), false);
  assert.equal(isOpen('/c', toggles, '/c', '/c'), true);
});

test('activating a workspace force-opens that group and leaves others expanded', () => {
  let toggles = rememberOpenWorkspaceTrees(emptyWorkspaceTreeToggles(), ['/a']);
  toggles = openWorkspaceTreeToggles(toggles, '/c');
  assert.equal(isOpen('/a', toggles, '/c', null), true);
  assert.equal(isOpen('/c', toggles, '/c', null), true);
});

test('openWorkspaceTreeToggles clears a previous chevron collapse', () => {
  const collapsedActive = nextWorkspaceTreeToggles(emptyWorkspaceTreeToggles(), '/a', true);
  assert.equal(
    isOpen('/a', openWorkspaceTreeToggles(collapsedActive, '/a'), '/a', null),
    true,
  );
});

test('row click collapses the current workspace when it is already open', () => {
  const toggles = nextWorkspaceRowClickToggles({
    current: emptyWorkspaceTreeToggles(),
    path: '/a',
    activeWorkspace: '/a',
    focusedWorkspace: null,
  });
  assert.equal(isOpen('/a', toggles, '/a', null), false);
});

test('row click expands the current workspace when it is collapsed', () => {
  const collapsed = nextWorkspaceTreeToggles(emptyWorkspaceTreeToggles(), '/a', true);
  const toggles = nextWorkspaceRowClickToggles({
    current: collapsed,
    path: '/a',
    activeWorkspace: '/a',
    focusedWorkspace: null,
  });
  assert.equal(isOpen('/a', toggles, '/a', null), true);
});

test('row click expands a non-current collapsed workspace without collapsing others', () => {
  let current = rememberOpenWorkspaceTrees(emptyWorkspaceTreeToggles(), ['/a']);
  current = nextWorkspaceRowClickToggles({
    current,
    path: '/b',
    activeWorkspace: '/a',
    focusedWorkspace: null,
  });
  assert.equal(isOpen('/a', current, '/b', null), true);
  assert.equal(isOpen('/b', current, '/b', null), true);
});

test('row click keeps a non-current already-open workspace open', () => {
  let current = rememberOpenWorkspaceTrees(emptyWorkspaceTreeToggles(), ['/a', '/b']);
  current = nextWorkspaceRowClickToggles({
    current,
    path: '/b',
    activeWorkspace: '/a',
    focusedWorkspace: null,
  });
  assert.equal(isOpen('/a', current, '/b', null), true);
  assert.equal(isOpen('/b', current, '/b', null), true);
});

test('row click collapses unassigned when it is already open', () => {
  const openUnassigned = openWorkspaceTreeToggles(
    emptyWorkspaceTreeToggles(),
    UNASSIGNED_WORKSPACE_KEY,
  );
  const toggles = nextWorkspaceRowClickToggles({
    current: openUnassigned,
    path: UNASSIGNED_WORKSPACE_KEY,
    activeWorkspace: '/a',
    focusedWorkspace: null,
  });
  assert.equal(isOpen(UNASSIGNED_WORKSPACE_KEY, toggles, '/a', null), false);
});

test('row click expands unassigned when it is collapsed', () => {
  const toggles = nextWorkspaceRowClickToggles({
    current: emptyWorkspaceTreeToggles(),
    path: UNASSIGNED_WORKSPACE_KEY,
    activeWorkspace: '/a',
    focusedWorkspace: null,
  });
  assert.equal(isOpen(UNASSIGNED_WORKSPACE_KEY, toggles, '/a', null), true);
});

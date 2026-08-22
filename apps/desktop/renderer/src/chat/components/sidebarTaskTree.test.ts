import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readSidebar = () => readFile(new URL('./Sidebar.tsx', import.meta.url), 'utf8');

test('sidebar mounts the task tree under each workspace and does not jump on workspace click', async () => {
  const source = await readSidebar();
  assert.match(source, /groupTasksByWorkspace\(workspaces, conversations\)/);
  assert.match(source, /sortWorkspaceTasks\(groupedTasks\.byPath\.get\(ws\.path\)/);
  assert.match(source, /renderConversationRow\(conv/);
  assert.match(source, /handleActivateWorkspace\(ws\.path\)/);
  assert.doesNotMatch(source, /handleOpenWorkspaceHome\(ws\.path\)/);
  assert.match(source, /设为当前工作区/);
  assert.match(source, /未归属/);
});

test('sidebar collapses workspace trees by default except the active or focused workspace', async () => {
  const source = await readSidebar();
  assert.match(source, /isWorkspaceTaskTreeOpen\(/);
  assert.match(source, /toggleWorkspaceTree\(ws\.path\)/);
  assert.match(source, /sidebar-workspace-chevron-btn/);
  assert.match(source, /openWorkspaceTreeToggles\(current, wsPath\)/);
  assert.match(source, /isTreeOpen && workspaceTasks\.length > 0/);
  assert.match(source, /UNASSIGNED_WORKSPACE_KEY/);
  assert.doesNotMatch(source, /加载更多任务/);
  assert.doesNotMatch(source, /onLoadMoreConversations/);
});

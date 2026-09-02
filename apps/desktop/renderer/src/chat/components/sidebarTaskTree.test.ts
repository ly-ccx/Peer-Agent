import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readSidebar = () => readFile(new URL('./Sidebar.tsx', import.meta.url), 'utf8');

test('sidebar mounts the task tree under each workspace and does not jump on workspace click', async () => {
  const source = await readSidebar();
  assert.match(source, /groupTasksByWorkspace\(workspaces, mergedConversations\)/);
  assert.match(source, /sortWorkspaceTasks\(groupedTasks\.byPath\.get\(ws\.path\)/);
  assert.match(source, /renderConversationRow\(conv/);
  assert.match(source, /handleWorkspaceRowClick\(ws\.path\)/);
  assert.match(source, /handleActivateWorkspace\(wsPath\)/);
  assert.doesNotMatch(source, /handleOpenWorkspaceHome\(ws\.path\)/);
  assert.match(source, /设为当前工作区/);
  assert.match(source, /未归属/);
});

test('sidebar auto-opens active or focused workspace without accordion-collapsing other groups', async () => {
  const source = await readSidebar();
  assert.match(source, /isWorkspaceTaskTreeOpen\(/);
  assert.match(source, /toggleWorkspaceTree\(ws\.path, isTreeOpen\)/);
  assert.match(source, /sidebar-workspace-chevron-btn/);
  assert.match(source, /handleWorkspaceRowClick\(ws\.path\)/);
  assert.match(source, /handleWorkspaceRowClick\(UNASSIGNED_WORKSPACE_KEY\)/);
  assert.match(source, /nextWorkspaceRowClickToggles\(/);
  assert.match(source, /openWorkspaceTreeToggles\(current, wsPath\)/);
  assert.match(source, /rememberOpenWorkspaceTrees\(current, \[activeWorkspace, focusedWorkspace\]\)/);
  assert.match(source, /UNASSIGNED_WORKSPACE_KEY/);
  assert.doesNotMatch(source, /toggled: workspaceTreeToggles/);
  assert.doesNotMatch(source, /加载更多任务/);
  assert.doesNotMatch(source, /onLoadMoreConversations/);
});

test('sidebar previews workspace tasks and loads more on demand instead of counting everything', async () => {
  const source = await readSidebar();
  const app = await readFile(new URL('../../App.tsx', import.meta.url), 'utf8');
  assert.match(source, /previewWorkspaceTasks\(workspaceTasks, revealedCount\(ws\.path\)\)/);
  assert.match(source, /sidebar-workspace-task-more/);
  assert.match(source, /isZh \? '更多' : 'More'/);
  assert.doesNotMatch(source, /sidebar-workspace-task-count/);
  assert.doesNotMatch(app, /余页在后台续拉，计数才完整/);
  assert.doesNotMatch(app, /shouldContinueConversationList/);
});

test('sidebar stacks pinned section above the workspace tree', async () => {
  const source = await readSidebar();
  const row = await readFile(new URL('./SidebarConversationRow.tsx', import.meta.url), 'utf8');
  assert.match(source, /sidebar-pinned-section/);
  assert.match(source, /pinnedSectionConversations/);
  assert.match(source, /mergePinnedSectionConversations\(allPinnedConversations, conversations\)/);
  assert.match(source, /optimisticUnpinnedIds/);
  assert.match(source, /setAllPinnedConversations\(\(prev\) => prev\.filter\(\(conv\) => conv\.id !== id\)\)/);
  assert.match(source, /isZh \? '置顶' : 'Pinned'/);
  assert.match(source, /isZh \? '工作区' : 'Workspaces'/);
  assert.match(source, /showWorkspace: true/);
  assert.doesNotMatch(source, /sidebar-list-tab/);
  assert.doesNotMatch(source, /setSidebarListTab/);
  assert.doesNotMatch(source, /role="tablist"/);
  assert.match(row, /showWorkspace && workspaceLabelFromPath\(conv\.workspacePath\)/);
  assert.match(row, /sidebar-conv-workspace/);
});

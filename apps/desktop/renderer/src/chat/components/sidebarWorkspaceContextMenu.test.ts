import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const sidebarSource = readFileSync(new URL('./Sidebar.tsx', import.meta.url), 'utf8');

test('workspace rows open a context menu instead of an inline remove button', () => {
  assert.match(sidebarSource, /className="sidebar-workspace-row"/);
  assert.match(
    sidebarSource,
    /setContextMenu\(\{ kind: 'workspace', x: e\.clientX, y: e\.clientY, workspace: ws \}\)/,
  );
  assert.doesNotMatch(sidebarSource, /sidebar-workspace-remove/);
  assert.doesNotMatch(sidebarSource, /sidebar-workspace-more/);
  assert.match(sidebarSource, /isZh \? '新建任务' : 'New Task'/);
  assert.match(sidebarSource, /className="sidebar-workspace-new-task"/);
  assert.match(
    sidebarSource,
    /event\.stopPropagation\(\);\s*handleNewWorkspaceTask\(ws\.path\)/,
  );
  assert.match(
    sidebarSource,
    /handleNewWorkspaceTask\(contextWorkspace\.path\)/,
  );
  assert.match(sidebarSource, /isZh \? '查看项目文件夹' : 'Show project folders'/);
  assert.match(sidebarSource, /setProjectPopoverPath\(contextWorkspace\.path\)/);
  assert.match(sidebarSource, /isZh \? '在 Finder 中显示' : 'Reveal in Finder'/);
  assert.match(sidebarSource, /isZh \? '移除' : 'Remove'/);
  assert.match(sidebarSource, /isZh \? '编辑项目' : 'Edit project'/);
  assert.match(sidebarSource, /className="sidebar-project-popover"/);
  assert.match(
    sidebarSource,
    /void handleRevealWorkspace\(contextWorkspace\.path\)/,
  );
  assert.match(
    sidebarSource,
    /void handleRemoveWorkspace\(contextWorkspace\.path\)/,
  );
  assert.match(sidebarSource, /会话记录会保留/);
  assert.doesNotMatch(sidebarSource, /会话记录将一并删除/);
});

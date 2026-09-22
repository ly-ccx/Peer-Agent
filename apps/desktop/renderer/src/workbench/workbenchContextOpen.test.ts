import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * 「文件」区 master-detail 的上下文契约（right-workbench-panel.md Q10/Q11）：
 *
 * Q10 点文件不切换一级 tab：FilesView 树点击走 openFileInPlace，只更新文档会话。
 * Q11 openFile 跨入口（聊天路径 / 产物条目）落点是 files 区 detail，不再是 documents。
 * documents 一级 tab 重定位为会话产物聚合（SessionArtifactsView），不内嵌预览。
 */

const context = readFileSync(new URL('./WorkbenchContext.tsx', import.meta.url), 'utf8');
const filesView = readFileSync(new URL('./views/FilesView.tsx', import.meta.url), 'utf8');
const panel = readFileSync(new URL('./WorkbenchPanel.tsx', import.meta.url), 'utf8');

test('openFileInPlace 只更新文档会话，不切一级 tab 也不强制开面板', () => {
  const def = context.match(/const openFileInPlace = useCallback\(([\s\S]*?)\n  \}, \[/);
  assert.ok(def, 'openFileInPlace must be defined via useCallback');
  assert.doesNotMatch(def[1], /setActiveTab/, 'in-place 打开不得切换一级 tab');
  assert.doesNotMatch(def[1], /setOpenByConversation|setOpen\(/, 'in-place 打开不得强制开面板');
  assert.match(def[1], /setDocumentSession/, 'in-place 打开只更新文档会话');
});

test('openFile 落点是 files 区 detail，不再切到 documents', () => {
  const def = context.match(/const openFile = useCallback\(([\s\S]*?)\n  \}, \[/);
  assert.ok(def, 'openFile must be defined via useCallback');
  assert.match(def[0], /openFileInPlace\(absPath, workspaceRoot, relPath, options\)/);
  assert.match(def[0], /prev\[key\] === 'files' \? prev : \{ \.\.\.prev, \[key\]: 'files' \}/);
  assert.doesNotMatch(def[0], /'documents'/);
});

test('FilesView 树点击消费 openFileInPlace 而不是 openFile', () => {
  assert.match(filesView, /openFileInPlace: openWorkbenchFile/);
  assert.doesNotMatch(filesView, /openFile: openWorkbenchFile/);
});

test('WorkbenchPanel：files 区挂 FilesPane，documents 区挂会话产物聚合', () => {
  assert.match(panel, /<FilesPane isZh=\{isZh\} workspacePath=\{workspacePath\} \/>/);
  assert.match(panel, /<SessionArtifactsView/);
  assert.match(panel, /aria-label=\{isZh \? '会话产物' : 'Session artifacts'\}/);
  assert.match(panel, /labelZh: '产物'/);
  // detail 预览（DocumentView）唯一宿主是 FilesPane；面板不得再直接挂载。
  assert.doesNotMatch(panel, /<DocumentView/);
});

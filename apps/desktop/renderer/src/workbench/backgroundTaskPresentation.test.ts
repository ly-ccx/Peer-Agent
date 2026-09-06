import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import type { ManagedShellTask } from '@peer-agent/protocol';
import { backgroundTaskList, backgroundTaskStatus, backgroundTaskAddresses } from './backgroundTaskPresentation.ts';

const task = (id: string, source: string | null, status = 'running'): ManagedShellTask => ({
  taskId: id, command: 'service', runInBackground: true, conversationId: source, status, cwd: `/project/${id}`,
});
const rows = [task('A', 'conversation-A'), task('B', 'conversation-B'), task('deleted', 'deleted-source'), task('global', null)];
test('global list has no implicit current-conversation filter, including deleted and absent sources', () => {
  assert.deepEqual(backgroundTaskList(rows).map((row) => row.taskId), ['A', 'B', 'deleted', 'global']);
  assert.deepEqual(backgroundTaskList(rows, { sourceConversation: 'conversation-B' }).map((row) => row.taskId), ['B']);
  assert.equal(backgroundTaskList(rows, { workspace: '/project/A' })[0].taskId, 'A');
  assert.equal(backgroundTaskList([{ ...rows[0], runInBackground: false }]).length, 0);
});
for (const [status, label] of [['running', '运行中'], ['stopping', '停止中'], ['success', '已完成'], ['failed', '失败'], ['cancelled', '已停止'], ['timeout', '超时']]) {
  test(`presentation_${status}_matches_runtime`, () => assert.equal(backgroundTaskStatus(task('A', null, status), true), label));
}
test('log URLs never become confirmed listeners, terminal tasks hide previous ports', () => {
  const row = { ...rows[0], stdout: 'http://127.0.0.1:5198' };
  assert.deepEqual(backgroundTaskAddresses(row), []);
  const listening: ManagedShellTask = { ...row, listeners: [{ host: '127.0.0.1', port: 12345, pid: 42, transport: 'tcp', observedAt: new Date().toISOString() }] };
  assert.deepEqual(backgroundTaskAddresses(listening), ['127.0.0.1:12345']);
  assert.deepEqual(backgroundTaskAddresses({ ...listening, status: 'cancelled' }), []);
});
test('single icon entry belongs to ChatHeader with application-owned shared state', () => {
  const entry = readFileSync(new URL('./GlobalBackgroundTasksButton.tsx', import.meta.url), 'utf8');
  const sidebar = readFileSync(new URL('../chat/components/Sidebar.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(sidebar, /GlobalBackgroundTasksButton/);
  const header = readFileSync(new URL('../chat/components/thread/ChatHeader.tsx', import.meta.url), 'utf8');
  assert.equal((header.match(/<GlobalBackgroundTasksButton /g) ?? []).length, 1);
  assert.ok(header.indexOf('<GlobalBackgroundTasksButton ') < header.indexOf('{onFind ?'));
  const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
  assert.equal((app.match(/<BackgroundRunsProvider /g) ?? []).length, 1);
  assert.match(entry, /chat-header-action-btn background-runtime-trigger/);
  const styles = readFileSync(new URL('../styles/workbench.css', import.meta.url), 'utf8');
  const sidebarStyles = readFileSync(new URL('../styles/sidebar.css', import.meta.url), 'utf8');
  assert.doesNotMatch(styles + sidebarStyles, /sidebar-background-runtime/);
  assert.match(styles, /\.background-runtime-trigger:focus-visible/);
  assert.doesNotMatch(entry, /<span>/);
  assert.match(entry, /useBackgroundRunStops\(reader.snapshot, reader.reload, isZh\)/);
  assert.match(entry, /<BackgroundRuntimePanel/);
  const panel = readFileSync(new URL('./BackgroundRuntimePanel.tsx', import.meta.url), 'utf8');
  assert.match(panel, /<Overlay anchor=/);
  const workbench = readFileSync(new URL('./WorkbenchPanel.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(workbench, /BackgroundThreadsView|id: 'threads'|workbench-view--threads/);
  for (const page of ['HomePage', 'GlobalWorkbenchPage']) {
    const source = readFileSync(new URL(`../app/pages/${page}.tsx`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /openBackgroundThread/);
    assert.match(source, /(?:item|i)\.source !== 'shell_background'/);
  }
  assert.doesNotMatch(entry, /useWorkbench|conversationId|activeConversation/);
});

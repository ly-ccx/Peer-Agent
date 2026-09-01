import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readSidebar = () => readFile(new URL('./Sidebar.tsx', import.meta.url), 'utf8');
const readWorkbenchCounts = () => readFile(new URL('./SidebarWorkbenchCounts.tsx', import.meta.url), 'utf8');
const readSidebarCss = () => readFile(new URL('../../styles/sidebar.css', import.meta.url), 'utf8');

test('global Workbench reuses the aggregated running-workspace projection', async () => {
  const source = await readSidebar();
  const counts = await readWorkbenchCounts();
  const workbenchStart = source.indexOf("activePage === 'home' && homeScope === 'all'");
  const workbenchEnd = source.indexOf("activePage === 'automations'", workbenchStart);
  const workbenchSource = source.slice(workbenchStart, workbenchEnd);

  assert.match(source, /const isAnyWorkspaceRunning = hasRunningWorkspaces\(runningWorkspacePaths\);/);
  assert.match(workbenchSource, /<SidebarWorkbenchCounts\b/);
  assert.match(counts, /sidebar-workbench-counts/);
  assert.match(counts, /需要你 \$\{inboxCounts\.needsYou\}/);
  assert.doesNotMatch(counts, /待验收/);
  assert.match(workbenchSource, /\{isAnyWorkspaceRunning \? \(/);
  assert.match(workbenchSource, /className="ws-running-dot"/);
  assert.match(workbenchSource, /aria-label=\{isZh \? '有任务运行中' : 'Tasks running'\}/);
});

test('global Workbench running dot sits at the navigation trailing edge', async () => {
  const css = await readSidebarCss();

  assert.match(
    css,
    /\.sidebar-top \.sidebar-automation-nav > \.ws-running-dot\s*\{[^}]*margin-left:\s*auto;/s,
  );
  assert.match(
    css,
    /\.sidebar-top \.sidebar-automation-nav > \.sidebar-workbench-counts \+ \.ws-running-dot\s*\{[^}]*margin-left:\s*6px;/s,
  );
});

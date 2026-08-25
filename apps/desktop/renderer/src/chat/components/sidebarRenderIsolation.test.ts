import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (rel: string) => readFile(new URL(rel, import.meta.url), 'utf8');

test('Sidebar isolates TaskOverview polling into SidebarWorkbenchCounts', async () => {
  const sidebar = await read('./Sidebar.tsx');
  const counts = await read('./SidebarWorkbenchCounts.tsx');

  assert.doesNotMatch(sidebar, /useTaskOverview\(/);
  assert.doesNotMatch(sidebar, /countWorkbenchInbox\(/);
  assert.match(sidebar, /<SidebarWorkbenchCounts\b/);
  assert.match(counts, /export const SidebarWorkbenchCounts = memo\(/);
  assert.match(counts, /useTaskOverview\(/);
});

test('Sidebar conversation rows are memo-isolated components', async () => {
  const sidebar = await read('./Sidebar.tsx');
  const row = await read('./SidebarConversationRow.tsx');

  assert.match(sidebar, /from '\.\/SidebarConversationRow'/);
  assert.match(sidebar, /<SidebarConversationRow\b/);
  assert.match(sidebar, /renderConversationRow\(/);
  assert.match(row, /export const SidebarConversationRow = memo\(/);
  assert.match(row, /awaitingGoalPlanCount/);
  assert.match(row, /pendingSensitiveCount/);
});

test('awaiting goal plan counts reuse previous Map when unchanged', async () => {
  const source = await read('./goal/useAwaitingGoalPlans.ts');
  assert.match(source, /setCounts\(\(prev\) => \{/);
  assert.match(source, /prev\.size !== next\.size/);
  assert.match(source, /return prev;/);
});

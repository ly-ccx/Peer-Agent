import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { blockedPlanIdsFromItem, resolveWorkbenchConversationId } from './openWorkbenchConversation.ts';

test('blockedPlanIdsFromItem prefers collapsed handoff ids over the source-block taskId', () => {
  assert.deepEqual(
    blockedPlanIdsFromItem({
      taskId: 'source-block:ws:branch',
      blockedPlanIds: ['plan-a', 'plan-b'],
    } as never),
    ['plan-a', 'plan-b'],
  );
});

test('blockedPlanIdsFromItem falls back to a real plan taskId', () => {
  assert.deepEqual(
    blockedPlanIdsFromItem({
      taskId: 'plan-a',
    } as never),
    ['plan-a'],
  );
});

test('resolveWorkbenchConversationId uses blocked plans when the card has no conversationId', async () => {
  const conversationId = await resolveWorkbenchConversationId(
    {
      taskId: 'source-block:ws:branch',
      blockedPlanIds: ['plan-a'],
    } as never,
    async (planId) => (planId === 'plan-a' ? { conversationId: 'conv-a' } : null),
  );
  assert.equal(conversationId, 'conv-a');
});

test('handle buttons open the related conversation instead of toggling an in-place panel', async () => {
  const page = await readFile(new URL('../pages/GlobalWorkbenchPage.tsx', import.meta.url), 'utf8');
  const home = await readFile(new URL('../pages/HomePage.tsx', import.meta.url), 'utf8');
  const app = await readFile(new URL('../../App.tsx', import.meta.url), 'utf8');

  assert.match(page, /onClick=\{\(\) => \{ void onOpen\(\); \}\}/);
  assert.doesNotMatch(page, /sourceOpen \? '收起' : '处理'/);
  assert.match(page, /sourceBlock\s*\n\s*\? '去对话'\s*\n\s*: item\.actionLabel \|\| '去处理'/);
  assert.doesNotMatch(page, /if \(isWorkbenchHandoffCard\(item\)\) return;/);
  assert.doesNotMatch(home, /if \(isWorkbenchHandoffCard\(item\)\) return;/);
  assert.doesNotMatch(app, /if \(isWorkbenchHandoffCard\(item\)\) return;/);
  assert.match(app, /resolveWorkbenchConversationId\(item\)/);
});

test('missing conversation shows a notice instead of opening the tasks drawer', async () => {
  const app = await readFile(new URL('../../App.tsx', import.meta.url), 'utf8');
  assert.match(app, /MISSING_WORKBENCH_CONVERSATION_NOTICE/);
  assert.match(app, /className="workbench-open-notice"/);
  const openItemHandlers = [...app.matchAll(
    /onOpenItem=\{\(item: TaskOverviewItem, options\?: OpenResultOptions\) => \{[\s\S]*?\n                      \}\}/g,
  )].map((match) => match[0]);
  assert.equal(openItemHandlers.length, 2);
  for (const handler of openItemHandlers) {
    assert.match(handler, /setWorkbenchOpenNotice\(MISSING_WORKBENCH_CONVERSATION_NOTICE\)/);
    assert.doesNotMatch(handler, /openCollectionDrawer\('tasks'\)/);
  }
});

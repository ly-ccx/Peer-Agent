import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const centerUrl = new URL('./AutomationCenter.tsx', import.meta.url);
const appUrl = new URL('../App.tsx', import.meta.url);

test('Automation list "New" jumps to chat new-task home via onCreateNew', async () => {
  const [center, app] = await Promise.all([
    readFile(centerUrl, 'utf8'),
    readFile(appUrl, 'utf8'),
  ]);

  assert.match(center, /readonly onCreateNew\?: \(\) => void;/);
  assert.match(center, /onCreateNew \? onCreateNew\(\) : openEditor\(\)/);
  assert.match(center, /copy\.newAutomation/);
  assert.match(center, /copy\.createAutomation/);

  // Editing an existing automation still uses the local editor path.
  assert.match(center, /onEdit=\{\(\) => openEditor\(selected\.definition\)\}/);

  // App jumps to chat new-task home and prefills a scheduled-task draft template.
  assert.match(app, /onCreateNew=\{handleCreateAutomation\}/);
  assert.match(app, /const handleCreateAutomation = useCallback\(async \(\) => \{/);
  assert.match(app, /conversationStore\.setDraft\(null, template\)/);
  assert.match(app, /getAutomationCopy\(.*\)\.chatDraftTemplate/);
  assert.match(app, /setActiveConversationId\(null\);/);
  assert.match(app, /setActivePage\('chat'\);/);

  const i18n = await readFile(new URL('./automationI18n.ts', import.meta.url), 'utf8');
  assert.match(i18n, /chatDraftTemplate: `Let's set up a scheduled task together/);
  assert.match(i18n, /chatDraftTemplate: `我们一起来设置一个已安排任务吧/);
});

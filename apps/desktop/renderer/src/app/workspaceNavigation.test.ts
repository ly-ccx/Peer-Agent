import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readAppSource = () => readFile(new URL('../App.tsx', import.meta.url), 'utf8');

test('switching workspaces selects the existing workbench tab', async () => {
  const app = await readAppSource();
  const callback = app.match(
    /const handleWorkspaceChanged = useCallback\(async \(\) => \{([\s\S]*?)\n  \}, \[applyConversationListPage, runningConversationIds\]\);/,
  );

  assert.ok(callback, 'expected the workspace-changed callback to remain explicit in App');
  assert.match(callback[1], /await clientApi\.workspaceList\(\);[\s\S]*?setActiveWorkspace\(r\.activeWorkspace\);[\s\S]*?setActivePage\('home'\);/);
  assert.doesNotMatch(callback[1], /setActivePage\('chat'\)/);
});

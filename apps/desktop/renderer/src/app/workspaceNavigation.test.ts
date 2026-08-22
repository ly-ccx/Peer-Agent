import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readAppSource = () => readFile(new URL('../App.tsx', import.meta.url), 'utf8');

test('switching workspaces does not leave the current task', async () => {
  const app = await readAppSource();
  const callback = app.match(
    /const handleWorkspaceChanged = useCallback\(async \(\) => \{([\s\S]*?)\n  \}, \[refreshConversations\]\);/,
  );

  assert.ok(callback, 'expected the workspace-changed callback to remain explicit in App');
  assert.match(callback[1], /await clientApi\.workspaceList\(\);[\s\S]*?setActiveWorkspace\(r\.activeWorkspace\);/);
  assert.doesNotMatch(callback[1], /setActivePage\('home'\)/);
  assert.doesNotMatch(callback[1], /setActiveConversationId\(next/);
});

test('sidebar workspace click only activates the workspace', async () => {
  const app = await readAppSource();
  const handler = app.match(
    /onOpenWorkspaceHome=\{\(workspacePath: string\) => \{([\s\S]*?)\n              \}\}/,
  )?.[1] ?? '';
  assert.match(handler, /setActiveWorkspace\(workspacePath\)/);
  assert.doesNotMatch(handler, /setActivePage\('home'\)/);
  assert.doesNotMatch(handler, /setHomeScope/);
});

test('draft workspace selection does not navigate the global workspace', async () => {
  const app = await readAppSource();
  const draftSurfaces = app.match(/setDraftWorkspacePath\(workspacePath\)/g) ?? [];

  assert.equal(draftSurfaces.length, 2, 'expected both draft chat surfaces to update draft state only');
  assert.doesNotMatch(
    app,
    /onWorkspaceChange=\{async \(workspacePath\) => \{[\s\S]*?workspaceSetActive/,
  );
});

test('draft submission receives the selected workspace path', async () => {
  const app = await readAppSource();
  const draftWorkspaceBindings = app.match(
    /workspacePath=\{activeConversationId \? activeWorkspace : draftWorkspacePath\}/g,
  ) ?? [];

  assert.equal(draftWorkspaceBindings.length, 2);
  assert.match(app, /const \[draftWorkspacePath, setDraftWorkspacePath\] = useState/);
  assert.match(app, /setDraftWorkspacePath\(ws\);[\s\S]*?setActiveConversationId\(null\)/);
  assert.doesNotMatch(app, /workspacePreviewDefault/);
});

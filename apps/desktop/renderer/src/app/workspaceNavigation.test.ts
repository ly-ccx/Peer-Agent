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

test('draft workspace selection does not navigate the global workspace', async () => {
  const app = await readAppSource();
  const draftSurfaces = app.match(/onWorkspaceChange=\{setDraftWorkspacePath\}/g) ?? [];

  assert.equal(draftSurfaces.length, 2, 'expected both draft chat surfaces to update draft state only');
  assert.doesNotMatch(
    app,
    /onWorkspaceChange=\{async \(nextWorkspacePath\) => \{[\s\S]*?workspaceSetActive/,
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
});

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readSource = (path: string) => readFile(new URL(path, import.meta.url), 'utf8');

test('new tasks require a registered workspace before chatStartTask', async () => {
  const [surface, app, composer, main] = await Promise.all([
    readSource('./ChatSurface.tsx'),
    readSource('../../App.tsx'),
    readSource('./ComposerDraftControls.tsx'),
    readSource('../../../../electron/main/main.mjs'),
  ]);

  assert.match(surface, /registeredWorkspacePath\(workspacePath, workspaces\)/);
  assert.match(surface, /isWorkspaceRequiredNotice/);
  assert.match(surface, /workspaceRequiredNotice/);
  assert.match(surface, /选择工作区/);
  assert.match(surface, /添加工作区/);
  assert.match(surface, /canStartTask=\{!isDraftConversation \|\| hasRegisteredWorkspace\}/);
  assert.match(composer, /!canStartTask/);
  assert.match(app, /registeredWorkspacePath/);
  assert.doesNotMatch(app, /workspacePreviewDefault/);
  assert.match(main, /resolveNewTaskWorkspacePath/);
  assert.match(main, /throw new Error\('workspace_required'\)/);
});

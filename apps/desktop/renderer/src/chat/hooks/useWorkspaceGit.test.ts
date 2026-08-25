import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readHook = () => readFile(new URL('./useWorkspaceGit.ts', import.meta.url), 'utf8');
const readSurface = () => readFile(new URL('../components/ChatSurface.tsx', import.meta.url), 'utf8');

test('workspace git refreshes after checkout without waiting for a new workspace path', async () => {
  const source = await readHook();

  assert.match(source, /gitListBranches\(\{ workspaceRoot: path \}\)/);
  assert.match(source, /window\.addEventListener\('focus', refresh\)/);
  assert.match(source, /document\.addEventListener\('visibilitychange', onVisibilityChange\)/);
  assert.match(source, /refreshWhenIdle/);
  assert.match(source, /if \(clear\) setWorkspaceGit\(null\)/);
  assert.match(source, /loadWorkspaceGit\(workspacePath, \{ clear: false \}\)/);
  assert.match(source, /localBranches/);
  assert.match(source, /remoteBranches/);
  assert.match(source, /refreshWorkspaceGit/);
  assert.doesNotMatch(source, /setInterval/);
});

test('ChatSurface reuses the workspace git hook and refreshes after a turn ends', async () => {
  const source = await readSurface();

  assert.match(source, /useWorkspaceGit/);
  assert.match(
    source,
    /useWorkspaceGit\(\s*workspacePath,\s*\{\s*refreshWhenIdle:\s*!isStreaming,\s*\}\)/,
  );
  assert.doesNotMatch(source, /void clientApi\.gitListBranches\(\{ workspaceRoot: workspacePath \}\)/);
});

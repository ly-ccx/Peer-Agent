import assert from 'node:assert/strict';
import test from 'node:test';
import { resourceDiffFiles, taskComparisonBinding } from './resourceComparisonState.ts';
import { decodeGitPath, groupDiffByFile } from './file-preview/diffLines.ts';

test('comparison index retains complete hunks and binary/deleted file identities', () => {
  const text = 'diff --git a/a.md b/a.md\n--- a/a.md\n+++ b/a.md\n@@ -1 +1 @@\n-old\n+new\n'
    + 'diff --git a/gone.md b/gone.md\ndeleted file mode 100644\n--- a/gone.md\n+++ /dev/null\n@@ -1 +0,0 @@\n-removed\n'
    + 'diff --git a/image.png b/image.png\nBinary files a/image.png and b/image.png differ\n';
  const files = resourceDiffFiles(text);
  assert.deepEqual(files.map(file => file.path), ['a.md', 'gone.md', 'image.png']);
  assert.equal(files.map(file => file.raw).join(''), text);
  assert.equal(files[0]?.additions, 1); assert.equal(files[0]?.deletions, 1);
  assert.equal(files[1]?.removed, true); assert.equal(files[2]?.binary, true);
});

test('Git quoted UTF-8 paths and rename targets remain usable file paths', () => {
  assert.equal(decodeGitPath('"a/\\346\\226\\207\\346\\241\\243.md"'), 'a/文档.md');
  const files = groupDiffByFile('diff --git "a/old name.md" "b/\\346\\226\\207\\346\\241\\243.md"\nsimilarity index 100%\nrename from old name.md\nrename to "\\346\\226\\207\\346\\241\\243.md"\n');
  assert.equal(files[0]?.path, '文档.md'); assert.equal(files[0]?.fromPath, 'old name.md');
});

test('task comparison requires matching host ownership and immutable baseline; missing worktrees never fall back', () => {
  const session = { workspaceId: 'bot', sessionId: 'task', report: { planId: 'plan' } };
  const plan = { planId: 'plan', delegationOrigin: { workspaceId: 'bot', sessionId: 'task' },
    deliveryBinding: { executionIsolation: 'worktree', worktreePath: '/task-tree', targetWorkspacePath: '/project', baseCommit: 'a'.repeat(40) } };
  assert.deepEqual(taskComparisonBinding(session, plan, 'bot', 'task'), { root: '/task-tree', base: 'a'.repeat(40), isolated: true });
  assert.equal(taskComparisonBinding(session, plan, 'other-bot', 'task'), null);
  assert.equal(taskComparisonBinding(session, { ...plan, delegationOrigin: { workspaceId: 'bot', sessionId: 'other-task' } }, 'bot', 'task'), null);
  assert.equal(taskComparisonBinding(session, { ...plan, deliveryBinding: { ...plan.deliveryBinding, worktreePath: undefined } }, 'bot', 'task'), null);
  assert.equal(taskComparisonBinding(session, { ...plan, deliveryBinding: { ...plan.deliveryBinding, baseCommit: 'HEAD' } }, 'bot', 'task'), null);
});

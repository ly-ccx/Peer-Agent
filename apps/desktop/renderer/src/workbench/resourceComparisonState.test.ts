import assert from 'node:assert/strict';
import test from 'node:test';
import { createFixedComparisonReader, resourceDiffFiles, taskComparisonBinding } from './resourceComparisonState.ts';
import { decodeGitPath, groupDiffByFile } from './file-preview/diffLines.ts';

test('explicit named comparison freezes both commits across refresh and re-resolves only for a new comparison', async () => {
  const calls: { fromRef: string; toRef?: string }[] = [];
  const first = 'a'.repeat(40), second = 'b'.repeat(40);
  const port = async (range: { fromRef: string; toRef?: string }) => {
    calls.push(range); return { ok: true, status: 'ok' as const, diffText: 'diff', fromRef: first, toRef: second };
  };
  const read = createFixedComparisonReader({ fromRef: 'main', toRef: 'topic' }, port);
  await read(); await read();
  assert.deepEqual(calls, [{ fromRef: 'main', toRef: 'topic' }, { fromRef: first, toRef: second }]);
  await createFixedComparisonReader({ fromRef: 'main', toRef: 'topic' }, port)();
  assert.equal(calls.at(-1)?.fromRef, 'main');
});

test('comparison initial resolution is coalesced; missing SHA fails closed and working tree remains current', async () => {
  let resolve!: (value: { ok: boolean; status: 'ok'; diffText: string; fromRef: string; toRef: null }) => void;
  let calls = 0;
  const read = createFixedComparisonReader({ fromRef: 'main' }, () => { calls++; return new Promise(done => { resolve = done; }); });
  const one = read(), two = read(); assert.equal(calls, 1);
  resolve({ ok: true, status: 'ok', diffText: 'diff', fromRef: 'a'.repeat(40), toRef: null });
  await Promise.all([one, two]);
  const ranges: unknown[] = [];
  const current = createFixedComparisonReader({ fromRef: 'main' }, async range => {
    ranges.push(range); return { ok: true, status: 'ok', diffText: '', fromRef: 'c'.repeat(40), toRef: null };
  });
  await current(); await current();
  assert.deepEqual(ranges[1], { fromRef: 'c'.repeat(40) });
  const invalid = await createFixedComparisonReader({ fromRef: 'main' }, async () => ({ ok: true, status: 'ok', diffText: 'unconfirmed', fromRef: 'main' }))();
  assert.equal(invalid.ok, false); assert.equal(invalid.diffText, ''); assert.equal(invalid.error, 'revision_unavailable');
});

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
  const renamed = resourceDiffFiles('diff --git a/old.md b/new.md\nsimilarity index 100%\nrename from old.md\nrename to new.md\n');
  assert.equal(renamed[0]?.fromPath, 'old.md'); assert.equal(renamed[0]?.path, 'new.md');
});

test('task comparison requires matching host ownership and immutable baseline; missing worktrees never fall back', () => {
  const session = { workspaceId: 'bot', sessionId: 'task', report: { planId: 'plan' } };
  const plan = { planId: 'plan', delegationOrigin: { workspaceId: 'bot', sessionId: 'task' },
    deliveryBinding: { executionIsolation: 'worktree', worktreePath: '/task-tree', targetWorkspacePath: '/project', baseCommit: 'a'.repeat(40) } };
  assert.deepEqual(taskComparisonBinding(session, plan, 'bot', 'task'), { root: '/task-tree', base: 'a'.repeat(40), isolated: true, task: { sessionId: 'task', planId: 'plan' } });
  assert.equal(taskComparisonBinding(session, plan, 'other-bot', 'task'), null);
  assert.equal(taskComparisonBinding(session, { ...plan, delegationOrigin: { workspaceId: 'bot', sessionId: 'other-task' } }, 'bot', 'task'), null);
  assert.equal(taskComparisonBinding(session, { ...plan, deliveryBinding: { ...plan.deliveryBinding, worktreePath: undefined } }, 'bot', 'task'), null);
  assert.equal(taskComparisonBinding(session, { ...plan, deliveryBinding: { ...plan.deliveryBinding, baseCommit: 'HEAD' } }, 'bot', 'task'), null);
});

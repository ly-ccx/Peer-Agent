import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import { buildDiffLines, countDiffLineStats, diffFileDisplayName, groupDiffByFile } from './diffLines.ts';

test('没有 @@ hunk 头时不产生 0 或任何假行号', () => {
  const lines = buildDiffLines('+name from path\n-generic label');
  assert.deepEqual(
    lines.map((line) => ({ kind: line.kind, text: line.text, oldNo: line.oldNo, newNo: line.newNo })),
    [
      { kind: 'add', text: 'name from path', oldNo: null, newNo: null },
      { kind: 'del', text: 'generic label', oldNo: null, newNo: null },
    ],
  );
  assert.equal(lines.some((line) => line.oldNo === 0 || line.newNo === 0), false);
});

test('有 @@ hunk 头时继续显示真实的 1-based 行号', () => {
  const lines = buildDiffLines(
    [
      '--- a/AGENTS.md',
      '+++ b/AGENTS.md',
      '@@ -12,2 +12,2 @@',
      '-generic label',
      '+name from path',
    ].join('\n'),
  );
  assert.deepEqual(
    lines
      .filter((line) => line.kind === 'add' || line.kind === 'del')
      .map((line) => ({ kind: line.kind, oldNo: line.oldNo, newNo: line.newNo })),
    [
      { kind: 'del', oldNo: 12, newNo: null },
      { kind: 'add', oldNo: null, newNo: 12 },
    ],
  );
});

test('range diff 收成文件名，不摊 git 协议头', () => {
  const files = groupDiffByFile([
    'diff --git a/apps/desktop/electron/ipc/channels.mjs b/apps/desktop/electron/ipc/channels.mjs',
    'index 0eb3641..87e8c08 100644',
    '--- a/apps/desktop/electron/ipc/channels.mjs',
    '+++ b/apps/desktop/electron/ipc/channels.mjs',
    '@@ -10,2 +10,4 @@',
    ' INVOKE_CHANNELS = [',
    '+  \'git:diff-range\',',
    '+  \'git:list-branches\',',
  ].join('\n'));

  assert.equal(files.length, 1);
  assert.equal(files[0]?.path, 'apps/desktop/electron/ipc/channels.mjs');
  assert.deepEqual(files[0]?.lines.map((line) => line.kind), ['hunk', 'ctx', 'add', 'add']);
  assert.equal(
    files.flatMap((file) => file.lines).some((line) => /diff --git|^index |^--- |^\+\+\+ /.test(line.text)),
    false,
  );
});

test('DiffViewer 用悬停弹层看对照，不用系统 tooltip', async () => {
  const source = await readFile(new URL('./DiffViewer.tsx', import.meta.url), 'utf8');
  const overlay = await readFile(new URL('../../styles/task-artifact-preview-overlay.css', import.meta.url), 'utf8');
  assert.match(source, /groupDiffByFile/);
  assert.match(source, /showFileIndex/);
  assert.match(source, /个文件已改/);
  assert.match(source, /createPortal/);
  assert.match(source, /diff-file-preview-portal/);
  assert.match(source, /onMouseEnter/);
  assert.doesNotMatch(source, /title=\{file\.path\}/);
  assert.doesNotMatch(source, /isZh \? '对照' : 'Review'/);
  assert.doesNotMatch(source, /scrollIntoView/);
  assert.doesNotMatch(source, /diff-line--meta/);
  assert.match(overlay, /\.diff-file-preview-portal \{/);
  assert.match(overlay, /font-size: var\(--za-code-font-size/);
});

test('counts added and deleted lines for the file index', () => {
  const files = groupDiffByFile([
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,2 +1,3 @@',
    '-old',
    '+new',
    '+also',
    'diff --git a/src/b.ts b/src/b.ts',
    '--- a/src/b.ts',
    '+++ b/src/b.ts',
    '@@ -1,1 +1,1 @@',
    '-gone',
  ].join('\n'));
  assert.deepEqual(countDiffLineStats(files[0]?.lines ?? []), { additions: 2, deletions: 1 });
  assert.deepEqual(countDiffLineStats(files[1]?.lines ?? []), { additions: 0, deletions: 1 });
  assert.equal(diffFileDisplayName('src/a.ts', ['src/a.ts', 'src/b.ts']), 'a.ts');
  assert.equal(
    diffFileDisplayName('app/a.ts', ['app/a.ts', 'lib/a.ts']),
    'app/a.ts',
  );
});

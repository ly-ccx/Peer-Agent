import assert from 'node:assert/strict';
import test from 'node:test';

import { buildDiffLines } from './diffLines.ts';

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

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('approval card lets the user edit success criteria before approving', async () => {
  const source = await readFile(new URL('./ChatGoalApprovalCard.tsx', import.meta.url), 'utf8');
  assert.match(source, /SuccessCriteriaEditor/);
  assert.match(source, /editorsRef\.current\.get\(plan\.planId\)\?\.flush/);
});

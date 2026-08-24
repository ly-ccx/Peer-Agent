import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readSource = () => readFile(new URL('./GoalPlanPanel.tsx', import.meta.url), 'utf8');

test('GoalPlanPanel treats missing evidenceRefs as an empty list', async () => {
  const source = await readSource();

  assert.match(source, /function safeEvidenceRefs\(/);
  assert.match(source, /Array\.isArray\(value\?\.evidenceRefs\) \? value\.evidenceRefs : \[\]/);
  assert.match(source, /const evidenceRefs = safeEvidenceRefs\(task\)/);
  assert.match(source, /const evidenceRefs = safeEvidenceRefs\(event\)/);
  assert.doesNotMatch(source, /task\.evidenceRefs\.length/);
  assert.doesNotMatch(source, /event\.evidenceRefs\.length/);
  assert.doesNotMatch(source, /task\.evidenceRefs\.map\(/);
});

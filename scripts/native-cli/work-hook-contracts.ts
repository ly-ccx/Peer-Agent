import assert from 'node:assert/strict';
import fixture from '../../packages/protocol/contracts/native-cli/work-hook.json';
import { WORK_HOOK_SEMANTIC_FLOOR, nativeWorkHasHookFacts } from '../../packages/protocol/src/work-hook.ts';

assert.equal(fixture.semanticFloor, WORK_HOOK_SEMANTIC_FLOOR);
for (const test of fixture.cases) {
  const before = structuredClone(test.work);
  if (typeof test.expected === 'boolean') {
    assert.equal(nativeWorkHasHookFacts(test.work), test.expected, test.name);
  } else {
    assert.throws(() => nativeWorkHasHookFacts(test.work), { message: test.expected }, test.name);
  }
  assert.deepEqual(test.work, before, test.name);
}
console.log(`${fixture.cases.length} canonical Work Hook records match.`);
